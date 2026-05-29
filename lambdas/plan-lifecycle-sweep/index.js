'use strict';

// EventBridge-scheduled Lambda (hourly): advances a plan's lifecycle by the
// clock. Replaces the old `recap-sweep` (which only completed plans).
//
//   active / locked  --(start time passed, still within duration)-->  ongoing
//   active / locked / ongoing  --(duration fully elapsed)-->           completed
//
// Plans with no `durationMinutes` have no "in progress" window, so they jump
// straight to `completed` once their start time passes. Uses the Plans
// `StatusIndex` GSI (hash=status, range=createdAt) to avoid a full table scan,
// and a conditional update so a cancelled plan is never clobbered.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PLANS_TABLE = process.env.DYNAMO_PLANS_TABLE || 'squadup-plans';
const STATUS_INDEX = process.env.PLANS_STATUS_INDEX || 'StatusIndex';
const LIVE_STATUSES = ['active', 'locked', 'ongoing'];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

exports.handler = async () => {
  const now = Date.now();
  let scanned = 0;
  let ongoing = 0;
  let completed = 0;

  for (const status of LIVE_STATUSES) {
    for await (const row of queryByStatus(status)) {
      scanned += 1;
      const target = nextStatus(row, now);
      if (!target || target === row.status) continue;
      const ok = await markStatus(row, target);
      if (ok && target === 'ongoing') ongoing += 1;
      if (ok && target === 'completed') completed += 1;
    }
  }

  console.log('plan lifecycle sweep finished', {
    scanned,
    ongoing,
    completed,
    now: new Date(now).toISOString(),
  });
  return { scanned, ongoing, completed };
};

async function* queryByStatus(status) {
  let lastKey;
  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: PLANS_TABLE,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of out.Items || []) {
      yield item;
    }
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
}

/**
 * The status a live plan should hold given the current time, or null when it
 * should stay where it is (not started yet, or unparseable start time).
 */
function nextStatus(row, now) {
  const startMs = row?.startAt ? Date.parse(row.startAt) : NaN;
  if (Number.isNaN(startMs)) return null;
  if (startMs > now) return null; // hasn't started

  const duration =
    typeof row.durationMinutes === 'number' && row.durationMinutes > 0
      ? row.durationMinutes
      : null;
  if (duration === null) return 'completed'; // no in-progress window

  const endMs = startMs + duration * 60_000;
  return now >= endMs ? 'completed' : 'ongoing';
}

async function markStatus(row, target) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId: row.planId, createdAt: row.createdAt },
        UpdateExpression: 'SET #s = :target',
        // Only advance plans still in a live state — never resurrect or
        // overwrite a cancelled / already-completed plan.
        ConditionExpression: '#s IN (:active, :locked, :ongoing)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':target': target,
          ':active': 'active',
          ':locked': 'locked',
          ':ongoing': 'ongoing',
        },
      })
    );
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    console.error('failed to advance plan', {
      planId: row.planId,
      error: err.message,
    });
    throw err;
  }
}
