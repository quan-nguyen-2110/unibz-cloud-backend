'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('./dynamo');
const { config } = require('../lib/config');

const PLANS_TABLE = config.dynamo.plans;
const TAPINS_TABLE = config.dynamo.tapIns;
const PHOTOS_TABLE = config.dynamo.planPhotos;

async function findPlanById(planId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: PLANS_TABLE,
      KeyConditionExpression: 'planId = :pid',
      ExpressionAttributeValues: { ':pid': planId },
      Limit: 1,
    })
  );
  return result.Items?.[0] ?? null;
}

async function tapInUserIdsForPlan(planId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TAPINS_TABLE,
      KeyConditionExpression: 'planId = :pid',
      ExpressionAttributeValues: { ':pid': planId },
    })
  );
  return (result.Items || []).map((row) => row.userId);
}

async function loadPlanPhotos(planId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: PHOTOS_TABLE,
      KeyConditionExpression: 'planId = :pid',
      ExpressionAttributeValues: { ':pid': planId },
    })
  );
  const items = result.Items || [];
  items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return items;
}

async function findPlanPhoto(planId, photoId) {
  const photos = await loadPlanPhotos(planId);
  return photos.find((p) => p.photoId === photoId) ?? null;
}

module.exports = {
  findPlanById,
  tapInUserIdsForPlan,
  loadPlanPhotos,
  findPlanPhoto,
};
