'use strict';

/** Default dev user id (must be a UUID — route validators require it). */
const DEFAULT_DEV_USER_ID = '00000000-0000-4000-a000-000000000001';

/** In-memory users for local Docker (`DEV_MEMORY_STORE=true`). */
const USERS = {
  [DEFAULT_DEV_USER_ID]: {
    userId: DEFAULT_DEV_USER_ID,
    username: 'ali',
    displayName: 'Ali',
    email: 'ali@squadup.local',
    bio: 'Local dev user',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  },
};

function get(userId) {
  if (USERS[userId]) return { ...USERS[userId] };
  return {
    userId,
    username: 'devuser',
    displayName: 'Dev User',
    email: 'dev@squadup.local',
    bio: '',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  };
}

function search(query, excludeUserId) {
  const q = query.toLowerCase();
  return Object.values(USERS)
    .filter(
      (u) =>
        u.userId !== excludeUserId &&
        (u.username.toLowerCase().startsWith(q) ||
          u.displayName.toLowerCase().includes(q))
    )
    .map(({ userId, username, displayName, avatarUrl }) => ({
      userId,
      username,
      displayName,
      avatarUrl,
    }));
}

module.exports = { DEFAULT_DEV_USER_ID, get, search };
