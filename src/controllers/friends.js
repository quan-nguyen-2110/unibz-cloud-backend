'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { getUserId } = require('../middleware/auth');
const { config } = require('../lib/config');
const { handleValidation, userIdField } = require('../lib/validate');
const { loadProfiles } = require('../lib/userProfiles');
const { listAcceptedFriendEdges } = require('../lib/friendIds');

const router = express.Router();
const FRIENDS_TABLE = config.dynamo.friends;

router.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const friends = await listAcceptedFriendEdges(userId);
    const otherIds = friends.map((f) =>
      f.userId === userId ? f.friendId : f.userId
    );
    const profiles = await loadProfiles(otherIds);
    res.json({ friends, profiles });
  } catch (err) {
    next(err);
  }
});

router.get('/requests', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        IndexName: 'FriendIndex',
        KeyConditionExpression: 'friendId = :uid',
        FilterExpression: '#st = :pending',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':pending': 'pending' },
      })
    );
    const requests = result.Items || [];
    const profiles = await loadProfiles(requests.map((r) => r.userId));
    res.json({ requests, profiles });
  } catch (err) {
    next(err);
  }
});

router.get('/outgoing', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: '#st = :pending',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':pending': 'pending' },
      })
    );
    const requests = result.Items || [];
    const profiles = await loadProfiles(requests.map((r) => r.friendId));
    res.json({ requests, profiles });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/request',
  userIdField('friendId'),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { friendId } = req.body;

      if (userId === friendId) {
        return res.status(400).json({ error: 'Cannot friend yourself' });
      }

      await ddb.send(
        new PutCommand({
          TableName: FRIENDS_TABLE,
          Item: {
            userId,
            friendId,
            status: 'pending',
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(friendId)',
        })
      );

      res.status(201).json({ success: true });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'Friend request already sent' });
      }
      next(err);
    }
  }
);

router.post(
  '/decline',
  userIdField('requesterId'),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { requesterId } = req.body;

      await ddb.send(
        new DeleteCommand({
          TableName: FRIENDS_TABLE,
          Key: { userId: requesterId, friendId: userId },
        })
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/accept',
  userIdField('requesterId'),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { requesterId } = req.body;
      const now = new Date().toISOString();

      await ddb.send(
        new PutCommand({
          TableName: FRIENDS_TABLE,
          Item: { userId: requesterId, friendId: userId, status: 'accepted', acceptedAt: now },
        })
      );
      await ddb.send(
        new PutCommand({
          TableName: FRIENDS_TABLE,
          Item: { userId, friendId: requesterId, status: 'accepted', acceptedAt: now },
        })
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/request/:friendId',
  userIdField('friendId', 'param'),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { friendId } = req.params;

      await ddb.send(
        new DeleteCommand({
          TableName: FRIENDS_TABLE,
          Key: { userId, friendId },
        })
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:friendId',
  userIdField('friendId', 'param'),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { friendId } = req.params;

      await Promise.all([
        ddb.send(new DeleteCommand({ TableName: FRIENDS_TABLE, Key: { userId, friendId } })),
        ddb.send(
          new DeleteCommand({ TableName: FRIENDS_TABLE, Key: { userId: friendId, friendId: userId } })
        ),
      ]);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
