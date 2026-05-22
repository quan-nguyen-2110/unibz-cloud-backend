'use strict';

/** In-memory plans for local Week 1 testing (no DynamoDB credentials). */
const plans = new Map();
const tapIns = new Map();

function tapKey(planId, userId) {
  return `${planId}#${userId}`;
}

function listByStatus(status) {
  return [...plans.values()].filter((p) => p.status === status);
}

function findPlan(planId) {
  for (const p of plans.values()) {
    if (p.planId === planId) return p;
  }
  return null;
}

function tapInUserIds(planId) {
  const ids = [];
  for (const [key, row] of tapIns) {
    if (row.planId === planId) ids.push(row.userId);
  }
  return ids;
}

function putPlan(item) {
  plans.set(`${item.planId}#${item.createdAt}`, item);
}

function addTapIn(planId, userId, tappedAt) {
  tapIns.set(tapKey(planId, userId), { planId, userId, tappedAt });
}

function removeTapIn(planId, userId) {
  tapIns.delete(tapKey(planId, userId));
}

function seedIfEmpty(hostId) {
  if (plans.size > 0) return;
  const now = new Date().toISOString();
  const start = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  putPlan({
    planId: '00000000-0000-4000-8000-000000000001',
    hostId,
    title: 'Pickup at Riverside courts',
    vibeEmoji: '🏀',
    emoji: '🏀',
    startAt: start,
    threshold: 4,
    maxAttendees: 4,
    tapInCount: 1,
    status: 'active',
    source: 'manual',
    activities: [],
    location: 'Riverside Basketball Courts',
    createdAt: now,
  });
  addTapIn('00000000-0000-4000-8000-000000000001', hostId, now);
}

module.exports = {
  listByStatus,
  findPlan,
  tapInUserIds,
  putPlan,
  addTapIn,
  removeTapIn,
  seedIfEmpty,
};
