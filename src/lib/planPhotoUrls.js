'use strict';

const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { config } = require('./config');

const BUCKET = config.s3.audioBucket;
const REGION = config.awsRegion;
const VIEW_URL_TTL = 60 * 60 * 24;

const s3 = new S3Client({ region: REGION });

async function photoViewUrl(s3Key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn: VIEW_URL_TTL });
}

async function attachPhotoUrls(photoRows) {
  const photos = [];
  for (const row of photoRows) {
    photos.push({
      id: row.photoId,
      url: await photoViewUrl(row.s3Key),
      uploaderId: row.uploaderId,
      createdAt: row.createdAt,
    });
  }
  return photos;
}

async function objectExists(s3Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

module.exports = { photoViewUrl, attachPhotoUrls, objectExists, VIEW_URL_TTL };
