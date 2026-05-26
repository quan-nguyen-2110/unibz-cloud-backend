'use strict';

const HOST_INITIAL_MAX = 5;
const PLAN_PHOTOS_MAX = 30;

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function extensionForContentType(contentType) {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'jpg';
  }
}

function isPlanStarted(planRow) {
  if (!planRow?.startAt) return false;
  return Date.now() >= new Date(planRow.startAt).getTime();
}

function isPlanCancelled(planRow) {
  return planRow?.status === 'cancelled';
}

function isPlanAttendee(userId, hostId, tapInUserIds) {
  if (userId === hostId) return true;
  return tapInUserIds.includes(userId);
}

function assertCanUpload(userId, planRow, tapInUserIds, currentCount) {
  if (isPlanCancelled(planRow)) {
    return { ok: false, status: 409, error: 'Plan is cancelled' };
  }

  const started = isPlanStarted(planRow);
  const host = userId === planRow.hostId;
  const attendee = isPlanAttendee(userId, planRow.hostId, tapInUserIds);

  if (!attendee) {
    return { ok: false, status: 403, error: 'Only attendees can add photos' };
  }

  if (!started) {
    if (!host) {
      return {
        ok: false,
        status: 403,
        error: 'Photos can only be added by the host before the plan starts',
      };
    }
    if (currentCount >= HOST_INITIAL_MAX) {
      return {
        ok: false,
        status: 409,
        error: `Maximum ${HOST_INITIAL_MAX} photos before the plan starts`,
      };
    }
    return { ok: true };
  }

  if (currentCount >= PLAN_PHOTOS_MAX) {
    return {
      ok: false,
      status: 409,
      error: `Maximum ${PLAN_PHOTOS_MAX} photos per plan`,
    };
  }

  return { ok: true };
}

function assertCanDelete(userId, photoRow, planRow, tapInUserIds) {
  if (photoRow.uploaderId !== userId) {
    return { ok: false, status: 403, error: 'You can only delete photos you uploaded' };
  }

  if (isPlanCancelled(planRow)) {
    return { ok: false, status: 409, error: 'Plan is cancelled' };
  }

  const started = isPlanStarted(planRow);
  if (!started) {
    return {
      ok: false,
      status: 403,
      error: 'Photos can only be removed after the plan starts',
    };
  }

  if (!isPlanAttendee(userId, planRow.hostId, tapInUserIds)) {
    return { ok: false, status: 403, error: 'Not allowed' };
  }

  return { ok: true };
}

function expectedS3Key(planId, photoId, contentType) {
  const ext = extensionForContentType(contentType);
  return `images/${planId}/${photoId}.${ext}`;
}

function assertValidS3Key(planId, photoId, s3Key, contentType) {
  const expected = expectedS3Key(planId, photoId, contentType);
  if (s3Key !== expected) {
    return { ok: false, error: 'Invalid s3Key for this photo' };
  }
  if (!s3Key.startsWith(`images/${planId}/`)) {
    return { ok: false, error: 'Invalid s3Key prefix' };
  }
  return { ok: true, expected };
}

module.exports = {
  HOST_INITIAL_MAX,
  PLAN_PHOTOS_MAX,
  ALLOWED_CONTENT_TYPES,
  extensionForContentType,
  isPlanStarted,
  isPlanCancelled,
  isPlanAttendee,
  assertCanUpload,
  assertCanDelete,
  expectedS3Key,
  assertValidS3Key,
};
