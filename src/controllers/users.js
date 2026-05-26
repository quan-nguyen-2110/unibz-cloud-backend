'use strict';

const express = require('express');
const { body, query, param } = require('express-validator');
const { GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { getUserId } = require('../middleware/auth');
const { config } = require('../lib/config');
const { handleValidation, userIdField } = require('../lib/validate');

const router = express.Router();
const USERS_TABLE = config.dynamo.users;

router.get('/me', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await ddb.send(
      new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
    );
    if (!result.Item) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.Item });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/me',
  body('displayName').optional().trim().isLength({ min: 1, max: 50 }),
  body('bio').optional().trim().isLength({ max: 200 }),
  body('city').optional().trim().isLength({ max: 80 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const names = {};
      const values = {};
      const parts = [];

      if (req.body.displayName !== undefined) {
        names['#dn'] = 'displayName';
        values[':dn'] = req.body.displayName;
        parts.push('#dn = :dn');
      }
      if (req.body.bio !== undefined) {
        values[':bio'] = req.body.bio;
        parts.push('bio = :bio');
      }
      if (req.body.city !== undefined) {
        values[':city'] = req.body.city;
        parts.push('city = :city');
      }
      if (!parts.length) return res.status(400).json({ error: 'Nothing to update' });

      await ddb.send(
        new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { userId },
          UpdateExpression: `SET ${parts.join(', ')}`,
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
        })
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/search',
  query('q').trim().isLength({ min: 2, max: 30 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const me = getUserId(req);
      const q = req.query.q.toLowerCase();
      const result = await ddb.send(
        new ScanCommand({
          TableName: USERS_TABLE,
          FilterExpression: 'begins_with(username, :q) AND userId <> :me',
          ExpressionAttributeValues: { ':q': q, ':me': me },
          Limit: 20,
          ProjectionExpression: 'userId, username, displayName, avatarUrl',
        })
      );
      res.json({ users: result.Items || [] });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id',
  userIdField('id', 'param'),
  handleValidation,
  async (req, res, next) => {
    try {
      const result = await ddb.send(
        new GetCommand({
          TableName: USERS_TABLE,
          Key: { userId: req.params.id },
          ProjectionExpression: 'userId, username, displayName, avatarUrl, bio, city, createdAt',
        })
      );
      if (!result.Item) return res.status(404).json({ error: 'User not found' });
      res.json({ user: result.Item });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
