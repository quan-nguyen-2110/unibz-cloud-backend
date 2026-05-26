'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load squadUp-backend/.env when running Node locally (not in ECS).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 8080,
  nodeEnv: process.env.NODE_ENV || 'development',
  awsRegion: process.env.AWS_REGION || 'us-east-1',

  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
  },

  dynamo: {
    users: process.env.DYNAMO_USERS_TABLE || 'squadup-users',
    plans: process.env.DYNAMO_PLANS_TABLE || 'squadup-plans',
    tapIns: process.env.DYNAMO_TAPINS_TABLE || 'squadup-tap-ins',
    friends: process.env.DYNAMO_FRIENDS_TABLE || 'squadup-friendships',
    planPhotos: process.env.DYNAMO_PLAN_PHOTOS_TABLE || 'squadup-plan-photos',
    notifications:
      process.env.DYNAMO_NOTIFICATIONS_TABLE || 'squadup-notifications',
  },

  s3: {
    audioBucket: process.env.S3_AUDIO_BUCKET || 'squadup-audio',
  },

  workers: {
    enabled: process.env.ENABLE_WORKERS !== 'false',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = { config };
