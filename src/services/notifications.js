'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('./dynamo');
const { config } = require('../lib/config');
const { sendToUser } = require('../hubs/feedHub');

const NOTIFICATIONS_TABLE = config.dynamo.notifications;
const USERS_TABLE = config.dynamo.users;

async function getUserDisplayName(userId) {
  const result = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );
  return result.Item?.displayName?.trim() || 'Someone';
}

function toApiNotification(row) {
  return {
    id: row.notificationId,
    type: row.type,
    planId: row.planId ?? null,
    title: row.title,
    body: row.body,
    read: row.read === true,
    createdAt: row.createdAt,
    metadata: row.metadata ?? {},
  };
}

async function createNotification({
  userId,
  type,
  planId,
  title,
  body,
  metadata = {},
}) {
  const notificationId = uuidv4();
  const createdAt = new Date().toISOString();
  const row = {
    userId,
    notificationId,
    type,
    planId: planId ?? null,
    title,
    body,
    read: false,
    createdAt,
    metadata,
  };

  await ddb.send(
    new PutCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: row,
    })
  );

  return toApiNotification(row);
}

/**
 * Notify each attendee that the host cancelled a plan (persist + realtime).
 */
async function notifyPlanCancelled({ plan, hostId, attendeeIds }) {
  if (!attendeeIds.length) return [];

  const hostName = await getUserDisplayName(hostId);
  const planTitle = plan.title?.trim() || 'your plan';
  const body = `${hostName} cancelled "${planTitle}".`;
  const created = [];

  const hubPayload = {
    planId: plan.planId,
    planTitle,
    hostId,
    hostName,
    message: body,
  };

  for (const userId of attendeeIds) {
    const notification = await createNotification({
      userId,
      type: 'plan_cancelled',
      planId: plan.planId,
      title: 'Plan cancelled',
      body,
      metadata: { hostId, hostName, planTitle },
    });
    created.push(notification);
    sendToUser(userId, 'planCancelled', {
      ...hubPayload,
      notificationId: notification.id,
    });
  }

  return created;
}

/**
 * Notify the host that someone joined their plan (persist + realtime to host only).
 */
async function notifyHostAttendeeJoined({ plan, hostId, attendeeId }) {
  if (!hostId || attendeeId === hostId) return null;

  const attendeeName = await getUserDisplayName(attendeeId);
  const planTitle = plan.title?.trim() || 'your plan';
  const body = `${attendeeName} joined "${planTitle}".`;

  const notification = await createNotification({
    userId: hostId,
    type: 'new_attendee',
    planId: plan.planId,
    title: 'Someone joined your plan',
    body,
    metadata: { attendeeId, attendeeName, planTitle },
  });

  sendToUser(hostId, 'newAttendee', {
    planId: plan.planId,
    planTitle,
    attendeeId,
    attendeeName,
    message: body,
    notificationId: notification.id,
  });

  return notification;
}

/**
 * Notify the host that someone left their plan (persist + realtime to host only).
 */
/**
 * Notify an attendee that the host removed them from a plan.
 */
async function notifyAttendeeRemovedByHost({ plan, hostId, attendeeId }) {
  if (!hostId || !attendeeId || attendeeId === hostId) return null;

  const hostName = await getUserDisplayName(hostId);
  const planTitle = plan.title?.trim() || 'a plan';
  const body = `${hostName} removed you from "${planTitle}".`;

  const notification = await createNotification({
    userId: attendeeId,
    type: 'removed_from_plan',
    planId: plan.planId,
    title: 'Removed from plan',
    body,
    metadata: { hostId, hostName, planTitle },
  });

  sendToUser(attendeeId, 'removedFromPlan', {
    planId: plan.planId,
    planTitle,
    hostId,
    hostName,
    message: body,
    notificationId: notification.id,
  });

  return notification;
}

async function notifyHostAttendeeLeft({ plan, hostId, attendeeId }) {
  if (!hostId || attendeeId === hostId) return null;

  const attendeeName = await getUserDisplayName(attendeeId);
  const planTitle = plan.title?.trim() || 'your plan';
  const body = `${attendeeName} left "${planTitle}".`;

  const notification = await createNotification({
    userId: hostId,
    type: 'attendee_left',
    planId: plan.planId,
    title: 'Someone left your plan',
    body,
    metadata: { attendeeId, attendeeName, planTitle },
  });

  sendToUser(hostId, 'attendeeLeft', {
    planId: plan.planId,
    planTitle,
    attendeeId,
    attendeeName,
    message: body,
    notificationId: notification.id,
  });

  return notification;
}

async function listForUser(userId, { unreadOnly = false, limit = 50 } = {}) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
      Limit: Math.min(limit, 100),
    })
  );

  let rows = result.Items || [];
  if (unreadOnly) {
    rows = rows.filter((r) => r.read !== true);
  }
  rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return rows.map(toApiNotification);
}

async function markRead(userId, notificationId) {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'userId = :uid AND notificationId = :nid',
      ExpressionAttributeValues: {
        ':uid': userId,
        ':nid': notificationId,
      },
      Limit: 1,
    })
  );
  const row = existing.Items?.[0];
  if (!row) return null;

  await ddb.send(
    new UpdateCommand({
      TableName: NOTIFICATIONS_TABLE,
      Key: { userId, notificationId },
      UpdateExpression: 'SET #read = :true',
      ExpressionAttributeNames: { '#read': 'read' },
      ExpressionAttributeValues: { ':true': true },
    })
  );

  return toApiNotification({ ...row, read: true });
}

/**
 * Notify recipient that someone sent a friend request (persist + realtime).
 */
async function notifyFriendRequest({ recipientId, requesterId }) {
  if (!recipientId || !requesterId || recipientId === requesterId) return null;

  const requesterName = await getUserDisplayName(requesterId);
  const body = `${requesterName} wants to be friends.`;

  const notification = await createNotification({
    userId: recipientId,
    type: 'friend_request',
    planId: null,
    title: 'New friend request',
    body,
    metadata: { requesterId, requesterName },
  });

  sendToUser(recipientId, 'friendRequest', {
    requesterId,
    requesterName,
    message: body,
    notificationId: notification.id,
  });

  return notification;
}

async function markAllRead(userId) {
  const items = await listForUser(userId, { unreadOnly: true, limit: 100 });
  for (const n of items) {
    await markRead(userId, n.id);
  }
  return items.length;
}

module.exports = {
  notifyPlanCancelled,
  notifyHostAttendeeJoined,
  notifyHostAttendeeLeft,
  notifyAttendeeRemovedByHost,
  notifyFriendRequest,
  listForUser,
  markRead,
  markAllRead,
  toApiNotification,
};
