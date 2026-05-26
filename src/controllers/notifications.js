'use strict';

const express = require('express');
const { param, query } = require('express-validator');

const { getUserId } = require('../middleware/auth');
const { handleValidation } = require('../lib/validate');
const {
  listForUser,
  markRead,
  markAllRead,
} = require('../services/notifications');

const router = express.Router();

router.get(
  '/',
  query('limit').optional().isInt({ min: 1, max: 100 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const unreadOnly = req.query.unreadOnly === 'true';
      const limit = parseInt(req.query.limit, 10) || 50;
      const notifications = await listForUser(userId, { unreadOnly, limit });
      const allUnread = unreadOnly
        ? notifications
        : await listForUser(userId, { unreadOnly: true, limit: 100 });
      const unreadCount = allUnread.filter((n) => !n.read).length;
      res.json({ notifications, count: notifications.length, unreadCount });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id/read',
  param('id').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const notification = await markRead(userId, req.params.id);
      if (!notification) {
        return res.status(404).json({ error: 'Notification not found' });
      }
      res.json({ notification });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/read-all', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const marked = await markAllRead(userId);
    res.json({ success: true, marked });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
