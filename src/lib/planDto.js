'use strict';

/** Maps DynamoDB plan rows + tap-in list to Flutter `SquadPlan` JSON. */

const API_STATUSES = new Set(['active', 'locked', 'completed']);
const API_SOURCES = new Set(['manual', 'voice', 'suggestion']);

function mapStatus(dbStatus) {
  if (dbStatus === 'locked') return 'locked';
  if (dbStatus === 'active') return 'active';
  if (dbStatus === 'expired' || dbStatus === 'cancelled') return 'completed';
  return API_STATUSES.has(dbStatus) ? dbStatus : 'active';
}

function normalizeActivities(row) {
  if (Array.isArray(row.activities) && row.activities.length > 0) {
    return row.activities.map((a) => ({
      emoji: a.emoji || row.vibeEmoji || row.emoji || '✨',
      title: a.title || row.title || '',
      location: a.location ?? null,
      durationMinutes:
        typeof a.durationMinutes === 'number' ? a.durationMinutes : null,
    }));
  }
  const loc = row.location?.name ?? row.location ?? null;
  return [
    {
      emoji: row.vibeEmoji || row.emoji || '✨',
      title: row.title || '',
      location: typeof loc === 'string' ? loc : null,
      durationMinutes: null,
    },
  ];
}

function toApiPlan(row, tapInUserIds = []) {
  if (!row) return null;
  const location =
    typeof row.location === 'string'
      ? row.location
      : row.location?.name ?? null;

  return {
    id: row.planId,
    creatorId: row.hostId,
    vibeEmoji: row.vibeEmoji || row.emoji || '✨',
    title: row.title,
    description: row.description ?? null,
    activities: normalizeActivities(row),
    gameName: row.gameName ?? null,
    location,
    startAt: row.startAt || row.createdAt,
    threshold: row.threshold ?? row.maxAttendees ?? 2,
    status: mapStatus(row.status),
    source: API_SOURCES.has(row.source) ? row.source : 'manual',
    transcript: row.transcript ?? null,
    tapInUserIds: [...tapInUserIds],
    createdAt: row.createdAt,
  };
}

function storageFromCreate(body, hostId, planId, nowIso) {
  const threshold = body.threshold ?? body.maxAttendees ?? 2;
  const location = body.location ?? null;
  const expiresInMinutes = body.expiresInMinutes ?? 120;
  const expiresAt = new Date(
    Date.now() + expiresInMinutes * 60_000
  ).toISOString();

  return {
    planId,
    hostId,
    title: body.title.trim(),
    vibeEmoji: body.vibeEmoji || body.emoji || '✨',
    emoji: body.vibeEmoji || body.emoji || '✨',
    description: body.description?.trim() || null,
    activities: Array.isArray(body.activities) ? body.activities : [],
    gameName: body.gameName ?? null,
    location:
      typeof location === 'string'
        ? location
        : location || null,
    startAt: body.startAt,
    threshold,
    maxAttendees: threshold,
    tapInCount: 0,
    status: 'active',
    source: API_SOURCES.has(body.source) ? body.source : 'manual',
    transcript: body.transcript ?? null,
    createdAt: nowIso,
    expiresAt: Math.floor(new Date(expiresAt).getTime() / 1000),
    expiresAtISO: expiresAt,
  };
}

module.exports = { toApiPlan, storageFromCreate, mapStatus };
