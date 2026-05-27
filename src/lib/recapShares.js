'use strict';

const { ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../services/dynamo');
const { config } = require('./config');
const { loadAcceptedFriendIds } = require('./friendIds');
const { toApiPlan } = require('./planDto');
const {
  findPlanById,
  tapInUserIdsForPlan,
} = require('../services/planQueries');

const PLANS_TABLE = config.dynamo.plans;
const TAPINS_TABLE = config.dynamo.tapIns;

function isPlanPast(row) {
  if (!row) return false;
  if (row.status === 'expired' || row.status === 'cancelled') return true;
  if (row.status === 'completed') return true;
  const startAt = row.startAt ? Date.parse(row.startAt) : NaN;
  if (!Number.isNaN(startAt) && startAt < Date.now()) return true;
  return false;
}

function canViewSharedRecap(viewerId, profileUserId, plan, friendIds) {
  if (viewerId === profileUserId) return true;
  const isFriend = friendIds?.has(profileUserId);
  if (isFriend) return true;
  return (plan.visibility || 'public') === 'public';
}

async function getTapIn(planId, userId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TAPINS_TABLE,
      Key: { planId, userId },
    })
  );
  return result.Item ?? null;
}

async function hydrateRecapPlan(row, meta) {
  const tapInUserIds = await tapInUserIdsForPlan(row.planId);
  return toApiPlan(row, tapInUserIds, [], meta);
}

/**
 * Past plans the user hosted or attended, with share flag + role.
 */
async function listRecapPlansForUser(userId) {
  const [tapInScan, hostScan] = await Promise.all([
    ddb.send(
      new ScanCommand({
        TableName: TAPINS_TABLE,
        FilterExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
      })
    ),
    ddb.send(
      new ScanCommand({
        TableName: PLANS_TABLE,
        FilterExpression: 'hostId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
      })
    ),
  ]);

  const entries = [];
  const seen = new Set();

  for (const row of hostScan.Items || []) {
    if (!isPlanPast(row)) continue;
    seen.add(row.planId);
    entries.push({
      row,
      sharedToProfile: !!row.hostSharedToProfile,
      recapRole: 'hosted',
    });
  }

  for (const tap of tapInScan.Items || []) {
    if (seen.has(tap.planId)) continue;
    const row = await findPlanById(tap.planId);
    if (!row || !isPlanPast(row) || row.hostId === userId) continue;
    seen.add(row.planId);
    entries.push({
      row,
      sharedToProfile: !!tap.sharedToProfile,
      recapRole: 'attended',
    });
  }

  entries.sort(
    (a, b) => (b.row.startAt || '').localeCompare(a.row.startAt || '')
  );

  const plans = [];
  for (const entry of entries) {
    plans.push(
      await hydrateRecapPlan(entry.row, {
        sharedToProfile: entry.sharedToProfile,
        recapRole: entry.recapRole,
      })
    );
  }
  return plans;
}

/**
 * Shared recaps on a profile, gated by viewer relationship + plan visibility.
 */
async function listProfileRecaps(profileUserId, viewerId) {
  const friendIds = await loadAcceptedFriendIds(viewerId);
  const entries = [];

  const hostScan = await ddb.send(
    new ScanCommand({
      TableName: PLANS_TABLE,
      FilterExpression:
        'hostId = :uid AND hostSharedToProfile = :true',
      ExpressionAttributeValues: {
        ':uid': profileUserId,
        ':true': true,
      },
    })
  );

  for (const row of hostScan.Items || []) {
    if (!isPlanPast(row)) continue;
    if (!canViewSharedRecap(viewerId, profileUserId, row, friendIds)) continue;
    entries.push({ row, recapRole: 'hosted' });
  }

  const tapScan = await ddb.send(
    new ScanCommand({
      TableName: TAPINS_TABLE,
      FilterExpression: 'userId = :uid AND sharedToProfile = :true',
      ExpressionAttributeValues: {
        ':uid': profileUserId,
        ':true': true,
      },
    })
  );

  const seen = new Set(entries.map((e) => e.row.planId));

  for (const tap of tapScan.Items || []) {
    if (seen.has(tap.planId)) continue;
    const row = await findPlanById(tap.planId);
    if (!row || !isPlanPast(row) || row.hostId === profileUserId) continue;
    if (!canViewSharedRecap(viewerId, profileUserId, row, friendIds)) continue;
    seen.add(row.planId);
    entries.push({ row, recapRole: 'attended' });
  }

  entries.sort(
    (a, b) => (b.row.startAt || '').localeCompare(a.row.startAt || '')
  );

  const plans = [];
  for (const entry of entries) {
    plans.push(
      await hydrateRecapPlan(entry.row, {
        sharedToProfile: true,
        recapRole: entry.recapRole,
      })
    );
  }
  return plans;
}

async function setProfileShare(userId, planId, sharedToProfile) {
  const plan = await findPlanById(planId);
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (!isPlanPast(plan)) {
    const err = new Error('Only past plans can be shared to your profile');
    err.status = 409;
    throw err;
  }

  if (plan.hostId === userId) {
    await ddb.send(
      new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId: plan.planId, createdAt: plan.createdAt },
        UpdateExpression: 'SET hostSharedToProfile = :v',
        ExpressionAttributeValues: { ':v': !!sharedToProfile },
      })
    );
    return hydrateRecapPlan(plan, {
      sharedToProfile: !!sharedToProfile,
      recapRole: 'hosted',
    });
  }

  const tap = await getTapIn(planId, userId);
  if (!tap) {
    const err = new Error('You did not attend this plan');
    err.status = 403;
    throw err;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TAPINS_TABLE,
      Key: { planId, userId },
      UpdateExpression: 'SET sharedToProfile = :v',
      ExpressionAttributeValues: { ':v': !!sharedToProfile },
    })
  );

  return hydrateRecapPlan(plan, {
    sharedToProfile: !!sharedToProfile,
    recapRole: 'attended',
  });
}

module.exports = {
  isPlanPast,
  canViewSharedRecap,
  listRecapPlansForUser,
  listProfileRecaps,
  setProfileShare,
};
