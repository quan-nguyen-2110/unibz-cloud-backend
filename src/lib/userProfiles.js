'use strict';

const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../services/dynamo');
const devUsers = require('../services/devUserStore');
const { config } = require('./config');

function publicUser(item) {
  if (!item) return null;
  return {
    userId: item.userId,
    username: item.username || '',
    displayName: item.displayName || 'User',
    bio: item.bio || '',
    avatarUrl: item.avatarUrl || null,
    city: item.city || '',
  };
}

async function loadProfiles(userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const profiles = {};

  if (config.devMemoryStore) {
    for (const id of unique) {
      const u = publicUser(devUsers.get(id));
      if (u) profiles[id] = u;
    }
    return profiles;
  }

  await Promise.all(
    unique.map(async (userId) => {
      try {
        const result = await ddb.send(
          new GetCommand({
            TableName: config.dynamo.users,
            Key: { userId },
            ProjectionExpression:
              'userId, username, displayName, avatarUrl, bio, city, createdAt',
          })
        );
        const u = publicUser(result.Item);
        if (u) profiles[userId] = u;
      } catch {
        /* skip missing profiles */
      }
    })
  );

  return profiles;
}

module.exports = { publicUser, loadProfiles };
