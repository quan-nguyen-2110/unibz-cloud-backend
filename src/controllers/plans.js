'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, query } = require('express-validator');
const {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { getUserId } = require('../middleware/auth');
const { broadcast } = require('../hubs/feedHub');
const { config } = require('../lib/config');
const { handleValidation } = require('../lib/validate');
const { toApiPlan, storageFromCreate } = require('../lib/planDto');
const mem = require('../services/devPlanStore');

const router = express.Router();
const useMem = () => config.devMemoryStore;
const PLANS_TABLE = config.dynamo.plans;
const TAPINS_TABLE = config.dynamo.tapIns;
const FRIENDS_TABLE = config.dynamo.friends;

async function listActivePlans(status, limit) {
  if (useMem()) {
    const items = mem.listByStatus(status).slice(0, limit);
    return { Items: items, Count: items.length };
  }
  return ddb.send(
    new QueryCommand({
      TableName: PLANS_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': status },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
}

async function findPlanById(planId) {
  if (useMem()) return mem.findPlan(planId);
  const result = await ddb.send(
    new QueryCommand({
      TableName: PLANS_TABLE,
      KeyConditionExpression: 'planId = :pid',
      ExpressionAttributeValues: { ':pid': planId },
      Limit: 1,
    })
  );
  return result.Items?.[0] ?? null;
}

async function tapInUserIdsForPlan(planId) {
  if (useMem()) return mem.tapInUserIds(planId);
  const result = await ddb.send(
    new QueryCommand({
      TableName: TAPINS_TABLE,
      KeyConditionExpression: 'planId = :pid',
      ExpressionAttributeValues: { ':pid': planId },
    })
  );
  return (result.Items || []).map((row) => row.userId);
}

async function hydratePlan(row) {
  if (!row) return null;
  const tapInUserIds = await tapInUserIdsForPlan(row.planId);
  return toApiPlan(row, tapInUserIds);
}

async function listFeedPlans(userId, statusFilter, limit) {
  const statuses =
    statusFilter === 'active' ? ['active', 'locked'] : [statusFilter];

  if (useMem()) {
    mem.seedIfEmpty(userId);
    const rows = [];
    for (const st of statuses) rows.push(...mem.listByStatus(st));
    const filtered = rows
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit);
    const plans = [];
    for (const row of filtered) {
      plans.push(await hydratePlan(row));
    }
    return { plans, count: plans.length };
  }

  const friendsResult = await ddb.send(
    new QueryCommand({
      TableName: FRIENDS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: '#st = :accepted',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
    })
  );

  const friendIds = new Set(
    (friendsResult.Items || []).map((f) => f.friendId)
  );
  friendIds.add(userId);

  const rows = [];
  for (const st of statuses) {
    const result = await listActivePlans(st, Math.min(limit * 3, 100));
    rows.push(...(result.Items || []));
  }

  const filtered = rows
    .filter((p) => friendIds.has(p.hostId))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);

  const plans = [];
  for (const row of filtered) {
    plans.push(await hydratePlan(row));
  }

  return { plans, count: plans.length };
}

const createValidators = [
  body('title').trim().notEmpty().isLength({ max: 200 }),
  body('vibeEmoji').optional().isString().isLength({ max: 8 }),
  body('startAt').isISO8601(),
  body('threshold').optional().isInt({ min: 2, max: 100 }),
  body('description').optional().isString().isLength({ max: 500 }),
  body('activities').optional().isArray(),
  body('location').optional().isString().isLength({ max: 200 }),
  body('gameName').optional().isString().isLength({ max: 100 }),
  body('source').optional().isIn(['manual', 'voice', 'suggestion']),
  body('transcript').optional().isString().isLength({ max: 5000 }),
  body('expiresInMinutes').optional().isInt({ min: 15, max: 1440 }),
  handleValidation,
];

router.post('/', createValidators, async (req, res, next) => {
  try {
    const hostId = getUserId(req);
    const nowIso = new Date().toISOString();
    const planId = uuidv4();
    const storage = storageFromCreate(req.body, hostId, planId, nowIso);

    if (useMem()) {
      mem.putPlan(storage);
    } else {
      await ddb.send(new PutCommand({ TableName: PLANS_TABLE, Item: storage }));
    }

    const plan = toApiPlan(storage, []);
    broadcast('planCreated', { plan });

    res.status(201).json({ plan });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/feed',
  query('status').optional().isIn(['active', 'locked', 'completed']),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const status = req.query.status || 'active';
      const limit = parseInt(req.query.limit, 10) || 20;
      const { plans, count } = await listFeedPlans(userId, status, limit);
      res.json({ plans, count });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  query('status').optional().isIn(['active', 'locked', 'completed']),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const status = req.query.status || 'active';
      const limit = parseInt(req.query.limit, 10) || 20;
      const result = await listActivePlans(status, limit);
      const plans = [];
      for (const row of result.Items || []) {
        plans.push(await hydratePlan(row));
      }
      res.json({ plans, count: plans.length });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id/tap-ins',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const tapInUserIds = await tapInUserIdsForPlan(req.params.id);
      res.json({ tapInUserIds, count: tapInUserIds.length });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const row = await findPlanById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Plan not found' });
      res.json({ plan: await hydratePlan(row) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/tap-in',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const planId = req.params.id;
      const now = new Date().toISOString();

      const plan = await findPlanById(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status !== 'active') {
        return res.status(409).json({ error: 'Plan is no longer active' });
      }

      const threshold = plan.threshold ?? plan.maxAttendees ?? 2;
      if (plan.tapInCount >= threshold) {
        return res.status(409).json({ error: 'Plan is full' });
      }

      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TAPINS_TABLE,
                Item: { planId, userId, tappedAt: now },
                ConditionExpression: 'attribute_not_exists(userId)',
              },
            },
            {
              Update: {
                TableName: PLANS_TABLE,
                Key: { planId, createdAt: plan.createdAt },
                UpdateExpression: 'SET tapInCount = tapInCount + :one',
                ExpressionAttributeValues: { ':one': 1 },
              },
            },
          ],
        })
      );

      const newCount = plan.tapInCount + 1;
      let squadLocked = false;

      broadcast('planTapIn', { planId, userId, tappedAt: now, tapInCount: newCount });

      if (newCount >= threshold) {
        squadLocked = true;
        await ddb.send(
          new UpdateCommand({
            TableName: PLANS_TABLE,
            Key: { planId, createdAt: plan.createdAt },
            UpdateExpression: 'SET #st = :locked',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: { ':locked': 'locked' },
          })
        );
        broadcast('planLocked', { planId, tapInCount: newCount });
      }

      res.json({ squadLocked });
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        return res.status(409).json({ error: 'Already tapped in or plan changed' });
      }
      next(err);
    }
  }
);

router.delete(
  '/:id/tap-in',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const planId = req.params.id;

      const plan = await findPlanById(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status === 'locked') {
        return res.status(409).json({ error: 'Plan is locked — cannot leave' });
      }

      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: TAPINS_TABLE,
                Key: { planId, userId },
                ConditionExpression: 'attribute_exists(userId)',
              },
            },
            {
              Update: {
                TableName: PLANS_TABLE,
                Key: { planId, createdAt: plan.createdAt },
                UpdateExpression: 'SET tapInCount = tapInCount - :one',
                ConditionExpression: 'tapInCount > :zero',
                ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
              },
            },
          ],
        })
      );

      broadcast('planTapOut', { planId, userId });
      res.json({ success: true });
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        return res.status(409).json({ error: 'Not tapped in' });
      }
      next(err);
    }
  }
);

router.delete(
  '/:id',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const planId = req.params.id;

      const plan = await findPlanById(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.hostId !== userId) {
        return res.status(403).json({ error: 'Not the host' });
      }

      await ddb.send(
        new UpdateCommand({
          TableName: PLANS_TABLE,
          Key: { planId, createdAt: plan.createdAt },
          UpdateExpression: 'SET #st = :cancelled',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':cancelled': 'cancelled' },
        })
      );

      broadcast('planCancelled', { planId, creatorId: userId });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
