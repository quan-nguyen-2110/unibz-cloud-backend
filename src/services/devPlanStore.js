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

function seedIfEmpty(_hostId) {
  // No seed data — plans come from API create flow only.
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
