'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param } = require('express-validator');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { config } = require('../lib/config');
const { handleValidation } = require('../lib/validate');
const { getUserId } = require('../middleware/auth');
const { canViewPlan } = require('../lib/planDto');
const { loadAcceptedFriendIds } = require('../lib/friendIds');
const {
  findPlanById,
  tapInUserIdsForPlan,
  loadPlanPhotos,
  findPlanPhoto,
} = require('../services/planQueries');
const {
  ALLOWED_CONTENT_TYPES,
  assertCanUpload,
  assertCanDelete,
  expectedS3Key,
  assertValidS3Key,
} = require('../lib/planPhotos');
const { attachPhotoUrls, objectExists, photoViewUrl } = require('../lib/planPhotoUrls');

const router = express.Router({ mergeParams: true });
const PHOTOS_TABLE = config.dynamo.planPhotos;
const BUCKET = config.s3.audioBucket;
const REGION = config.awsRegion;
const PRESIGN_TTL = 300;

const s3 = new S3Client({ region: REGION });

async function assertPlanAccess(req, res) {
  const userId = getUserId(req);
  const planId = req.params.planId;
  const plan = await findPlanById(planId);
  if (!plan) {
    res.status(404).json({ error: 'Plan not found' });
    return null;
  }
  const friendIds = await loadAcceptedFriendIds(userId);
  if (!canViewPlan(userId, plan, friendIds)) {
    res.status(403).json({ error: 'Not allowed to view this plan' });
    return null;
  }
  const tapInUserIds = await tapInUserIdsForPlan(planId);
  return { userId, planId, plan, tapInUserIds };
}

router.post(
  '/presign',
  body('contentType')
    .isString()
    .custom((v) => ALLOWED_CONTENT_TYPES.has(v)),
  handleValidation,
  async (req, res, next) => {
    try {
      const ctx = await assertPlanAccess(req, res);
      if (!ctx) return;

      const { userId, planId, plan, tapInUserIds } = ctx;
      const photos = await loadPlanPhotos(planId);
      const uploadCheck = assertCanUpload(userId, plan, tapInUserIds, photos.length);
      if (!uploadCheck.ok) {
        return res.status(uploadCheck.status).json({ error: uploadCheck.error });
      }

      const photoId = uuidv4();
      const contentType = req.body.contentType;
      const s3Key = expectedS3Key(planId, photoId, contentType);

      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ContentType: contentType,
      });
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL });

      res.json({
        uploadUrl,
        photoId,
        s3Key,
        expiresIn: PRESIGN_TTL,
        instructions: 'PUT image bytes to uploadUrl, then POST /plans/{planId}/photos to confirm',
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  body('photoId').isUUID(),
  body('s3Key').isString().notEmpty(),
  body('contentType')
    .isString()
    .custom((v) => ALLOWED_CONTENT_TYPES.has(v)),
  handleValidation,
  async (req, res, next) => {
    try {
      const ctx = await assertPlanAccess(req, res);
      if (!ctx) return;

      const { userId, planId, plan, tapInUserIds } = ctx;
      const { photoId, s3Key, contentType } = req.body;

      const keyCheck = assertValidS3Key(planId, photoId, s3Key, contentType);
      if (!keyCheck.ok) {
        return res.status(400).json({ error: keyCheck.error });
      }

      const photos = await loadPlanPhotos(planId);
      if (photos.some((p) => p.photoId === photoId)) {
        return res.status(409).json({ error: 'Photo already registered' });
      }

      const uploadCheck = assertCanUpload(userId, plan, tapInUserIds, photos.length);
      if (!uploadCheck.ok) {
        return res.status(uploadCheck.status).json({ error: uploadCheck.error });
      }

      const exists = await objectExists(s3Key);
      if (!exists) {
        return res.status(400).json({ error: 'Upload not found in storage — PUT to presigned URL first' });
      }

      const nowIso = new Date().toISOString();
      await ddb.send(
        new PutCommand({
          TableName: PHOTOS_TABLE,
          Item: {
            planId,
            photoId,
            s3Key,
            contentType,
            uploaderId: userId,
            createdAt: nowIso,
          },
          ConditionExpression: 'attribute_not_exists(photoId)',
        })
      );

      const url = await photoViewUrl(s3Key);
      res.status(201).json({
        photo: {
          id: photoId,
          url,
          uploaderId: userId,
          createdAt: nowIso,
        },
      });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'Photo already registered' });
      }
      next(err);
    }
  }
);

router.get('/', async (req, res, next) => {
  try {
    const ctx = await assertPlanAccess(req, res);
    if (!ctx) return;

    const rows = await loadPlanPhotos(ctx.planId);
    const photos = await attachPhotoUrls(rows);
    res.json({ photos, count: photos.length });
  } catch (err) {
    next(err);
  }
});

router.delete(
  '/:photoId',
  param('photoId').isUUID(),
  handleValidation,
  async (req, res, next) => {
    try {
      const ctx = await assertPlanAccess(req, res);
      if (!ctx) return;

      const { userId, planId, plan, tapInUserIds } = ctx;
      const photoId = req.params.photoId;
      const photo = await findPlanPhoto(planId, photoId);
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      const deleteCheck = assertCanDelete(userId, photo, plan, tapInUserIds);
      if (!deleteCheck.ok) {
        return res.status(deleteCheck.status).json({ error: deleteCheck.error });
      }

      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: photo.s3Key,
          })
        );
      } catch (err) {
        if (err.name !== 'NoSuchKey') throw err;
      }

      await ddb.send(
        new DeleteCommand({
          TableName: PHOTOS_TABLE,
          Key: { planId, photoId },
        })
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
