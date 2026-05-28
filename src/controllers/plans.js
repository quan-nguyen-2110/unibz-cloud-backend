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
const { toApiPlan, storageFromCreate, canViewPlan } = require('../lib/planDto');
const {
  listRecapPlansForUser,
  setProfileShare,
} = require('../lib/recapShares');
const { loadAcceptedFriendIds } = require('../lib/friendIds');
const {
  findPlanById,
  tapInUserIdsForPlan,
  loadPlanPhotos,
} = require('../services/planQueries');
const { attachPhotoUrls } = require('../lib/planPhotoUrls');
const { isPlanStarted, isPlanCancelled } = require('../lib/planPhotos');
const {
  notifyPlanCancelled,
  notifyHostAttendeeJoined,
  notifyHostAttendeeLeft,
  notifyAttendeeRemovedByHost,
} = require('../services/notifications');

const router = express.Router();
const PLANS_TABLE = config.dynamo.plans;
const TAPINS_TABLE = config.dynamo.tapIns;

async function listActivePlans(status, limit) {
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

async function hydratePlan(row, { includePhotos = false } = {}) {
  if (!row) return null;
  const tapInUserIds = await tapInUserIdsForPlan(row.planId);
  let photos = [];
  if (includePhotos) {
    const rows = await loadPlanPhotos(row.planId);
    photos = await attachPhotoUrls(rows);
  }
  return toApiPlan(row, tapInUserIds, photos);
}

async function listFeedPlans(userId, statusFilter, limit, offset = 0) {
  const statuses =
    statusFilter === 'active' ? ['active', 'locked'] : [statusFilter];

  const friendIds = await loadAcceptedFriendIds(userId);

  const fetchCap = Math.min(Math.max((offset + limit) * 5, limit * 5), 250);
  const rows = [];
  for (const st of statuses) {
    const result = await listActivePlans(st, fetchCap);
    rows.push(...(result.Items || []));
  }

  const filtered = rows
    .filter((p) => canViewPlan(userId, p, friendIds))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const pageRows = filtered.slice(offset, offset + limit);
  const plans = [];
  for (const row of pageRows) {
    plans.push(await hydratePlan(row, { includePhotos: false }));
  }

  const hasMore = filtered.length > offset + limit;

  return {
    plans,
    count: plans.length,
    hasMore,
    offset,
    nextOffset: offset + plans.length,
  };
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
  body('visibility').optional().isIn(['public', 'private']),
  handleValidation,
];

router.post('/', createValidators, async (req, res, next) => {
  try {
    const hostId = getUserId(req);
    const nowIso = new Date().toISOString();
    const planId = uuidv4();
    const storage = storageFromCreate(req.body, hostId, planId, nowIso);

    await ddb.send(new PutCommand({ TableName: PLANS_TABLE, Item: storage }));

    const plan = toApiPlan(storage, [], []);
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
  query('offset').optional().isInt({ min: 0, max: 500 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const status = req.query.status || 'active';
      const limit = parseInt(req.query.limit, 10) || 20;
      const offset = parseInt(req.query.offset, 10) || 0;
      const result = await listFeedPlans(userId, status, limit, offset);
      res.json(result);
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
        plans.push(await hydratePlan(row, { includePhotos: false }));
      }
      res.json({ plans, count: plans.length });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/recaps', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const plans = await listRecapPlansForUser(userId);
    res.json({ plans, count: plans.length });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id/profile-share',
  param('id').isUUID(),
  body('sharedToProfile').isBoolean(),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const plan = await setProfileShare(
        userId,
        req.params.id,
        req.body.sharedToProfile
      );
      res.json({ plan });
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
      const userId = getUserId(req);
      const row = await findPlanById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Plan not found' });

      const friendIds = await loadAcceptedFriendIds(userId);
      if (!canViewPlan(userId, row, friendIds)) {
        return res.status(403).json({ error: 'Not allowed to view this plan' });
      }

      res.json({ plan: await hydratePlan(row, { includePhotos: true }) });
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

      const friendIds = await loadAcceptedFriendIds(userId);
      if (!canViewPlan(userId, plan, friendIds)) {
        return res.status(403).json({ error: 'Not allowed to join this plan' });
      }
      if (plan.status !== 'active') {
        return res.status(409).json({ error: 'Plan is no longer active' });
      }
      if (isPlanStarted(plan)) {
        return res.status(409).json({ error: 'Plan has already started' });
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
      if (plan.hostId && userId !== plan.hostId) {
        await notifyHostAttendeeJoined({
          plan,
          hostId: plan.hostId,
          attendeeId: userId,
        });
      }

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

async function removeTapInForUser(plan, userId) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TAPINS_TABLE,
            Key: { planId: plan.planId, userId },
            ConditionExpression: 'attribute_exists(userId)',
          },
        },
        {
          Update: {
            TableName: PLANS_TABLE,
            Key: { planId: plan.planId, createdAt: plan.createdAt },
            UpdateExpression: 'SET tapInCount = tapInCount - :one',
            ConditionExpression: 'tapInCount > :zero',
            ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
          },
        },
      ],
    })
  );
  broadcast('planTapOut', { planId: plan.planId, userId });
}

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

      await removeTapInForUser(plan, userId);

      if (plan.hostId && userId !== plan.hostId) {
        await notifyHostAttendeeLeft({
          plan,
          hostId: plan.hostId,
          attendeeId: userId,
        });
      }

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
  '/:id/attendees/:userId',
  param('id').isUUID(),
  param('userId').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const hostId = getUserId(req);
      const planId = req.params.id;
      const attendeeId = req.params.userId;

      const plan = await findPlanById(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.hostId !== hostId) {
        return res.status(403).json({ error: 'Only the host can remove attendees' });
      }
      if (isPlanCancelled(plan)) {
        return res.status(409).json({ error: 'Plan is cancelled' });
      }
      if (attendeeId === plan.hostId) {
        return res.status(400).json({ error: 'Cannot remove the host' });
      }

      const tapInUserIds = await tapInUserIdsForPlan(planId);
      if (!tapInUserIds.includes(attendeeId)) {
        return res.status(404).json({ error: 'User is not tapped in' });
      }

      await removeTapInForUser(plan, attendeeId);
      await notifyAttendeeRemovedByHost({ plan, hostId, attendeeId });

      res.json({ success: true });
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        return res.status(409).json({ error: 'Could not remove attendee' });
      }
      next(err);
    }
  }
);

const updateValidators = [
  param('id').isUUID(),
  body('title').optional().trim().notEmpty().isLength({ max: 200 }),
  body('vibeEmoji').optional().isString().isLength({ max: 8 }),
  body('startAt').optional().isISO8601(),
  body('threshold').optional().isInt({ min: 2, max: 100 }),
  body('description').optional().isString().isLength({ max: 500 }),
  body('activities').optional().isArray(),
  body('location').optional().isString().isLength({ max: 200 }),
  body('gameName').optional().isString().isLength({ max: 100 }),
  body('visibility').optional().isIn(['public', 'private']),
  handleValidation,
];

router.put('/:id', updateValidators, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const planId = req.params.id;

    const plan = await findPlanById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.hostId !== userId) {
      return res.status(403).json({ error: 'Not the host' });
    }
    if (isPlanCancelled(plan)) {
      return res.status(409).json({ error: 'Plan is cancelled' });
    }
    if (isPlanStarted(plan)) {
      return res.status(409).json({ error: 'Plan has already started' });
    }

    const names = {};
    const values = {};
    const sets = [];

    if (req.body.title !== undefined) {
      sets.push('title = :title');
      values[':title'] = req.body.title.trim();
    }
    if (req.body.vibeEmoji !== undefined) {
      const emoji = req.body.vibeEmoji;
      sets.push('vibeEmoji = :vibeEmoji', 'emoji = :vibeEmoji');
      values[':vibeEmoji'] = emoji;
    }
    if (req.body.description !== undefined) {
      sets.push('description = :description');
      values[':description'] = req.body.description?.trim() || null;
    }
    if (req.body.activities !== undefined) {
      sets.push('activities = :activities');
      values[':activities'] = Array.isArray(req.body.activities)
        ? req.body.activities
        : [];
    }
    if (req.body.location !== undefined) {
      sets.push('#loc = :location');
      names['#loc'] = 'location';
      values[':location'] = req.body.location ?? null;
    }
    if (req.body.gameName !== undefined) {
      sets.push('gameName = :gameName');
      values[':gameName'] = req.body.gameName ?? null;
    }
    if (req.body.startAt !== undefined) {
      sets.push('startAt = :startAt');
      values[':startAt'] = req.body.startAt;
    }
    if (req.body.threshold !== undefined) {
      const threshold = req.body.threshold;
      const tapInCount = plan.tapInCount ?? 0;
      if (threshold < tapInCount) {
        return res.status(409).json({
          error: `Threshold cannot be below current tap-ins (${tapInCount})`,
        });
      }
      sets.push('threshold = :threshold', 'maxAttendees = :threshold');
      values[':threshold'] = threshold;
    }
    if (req.body.visibility !== undefined) {
      sets.push('visibility = :visibility');
      values[':visibility'] = req.body.visibility;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId, createdAt: plan.createdAt },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames:
          Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: values,
      })
    );

    const updated = await findPlanById(planId);
    const apiPlan = await hydratePlan(updated, { includePhotos: true });
    broadcast('planUpdated', { plan: apiPlan });
    res.json({ plan: apiPlan });
  } catch (err) {
    next(err);
  }
});

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
      if (plan.status === 'cancelled') {
        return res.json({ success: true, alreadyCancelled: true });
      }

      const tapInUserIds = await tapInUserIdsForPlan(planId);
      const attendeeIds = tapInUserIds.filter((id) => id !== userId);

      await ddb.send(
        new UpdateCommand({
          TableName: PLANS_TABLE,
          Key: { planId, createdAt: plan.createdAt },
          UpdateExpression: 'SET #st = :cancelled',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':cancelled': 'cancelled' },
        })
      );

      await notifyPlanCancelled({ plan, hostId: userId, attendeeIds });
      broadcast('planUpdated', {
        planId,
        status: 'cancelled',
        creatorId: userId,
      });
      res.json({ success: true, notifiedCount: attendeeIds.length });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
