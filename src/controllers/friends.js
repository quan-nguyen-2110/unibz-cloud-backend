'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { getUserId } = require('../middleware/auth');
const { config } = require('../lib/config');
const { handleValidation } = require('../lib/validate');

const router = express.Router();
const FRIENDS_TABLE = config.dynamo.friends;

router.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: '#st = :accepted',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
      })
    );
    res.json({ friends: result.Items || [] });
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
    res.json({ requests: result.Items || [] });
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
    res.json({ requests: result.Items || [] });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/request',
  body('friendId').isUUID(),
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
  body('requesterId').isUUID(),
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
  body('requesterId').isUUID(),
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
  param('friendId').isUUID(),
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
  param('friendId').isUUID(),
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
