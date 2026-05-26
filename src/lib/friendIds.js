'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { config } = require('./config');

const FRIENDS_TABLE = config.dynamo.friends;

/**
 * All accepted friend user ids for [userId] (both outbound and inbound edges).
 */
async function loadAcceptedFriendIds(userId) {
  const [outbound, inbound] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: '#st = :accepted',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
      })
    ),
    ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        IndexName: 'FriendIndex',
        KeyConditionExpression: 'friendId = :uid',
        FilterExpression: '#st = :accepted',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
      })
    ),
  ]);

  const ids = new Set();
  for (const row of outbound.Items || []) {
    if (row.friendId) ids.add(row.friendId);
  }
  for (const row of inbound.Items || []) {
    if (row.userId) ids.add(row.userId);
  }
  return ids;
}

/** Merged accepted friendship rows (deduped by pair). */
async function listAcceptedFriendEdges(userId) {
  const [outbound, inbound] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: '#st = :accepted',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
      })
    ),
    ddb.send(
      new QueryCommand({
        TableName: FRIENDS_TABLE,
        IndexName: 'FriendIndex',
        KeyConditionExpression: 'friendId = :uid',
        FilterExpression: '#st = :accepted',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':uid': userId, ':accepted': 'accepted' },
      })
    ),
  ]);

  const byPair = new Map();
  for (const row of [...(outbound.Items || []), ...(inbound.Items || [])]) {
    const pair = [row.userId, row.friendId].sort().join('|');
    byPair.set(pair, row);
  }
  return [...byPair.values()];
}

module.exports = { loadAcceptedFriendIds, listAcceptedFriendEdges };
