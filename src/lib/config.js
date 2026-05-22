'use strict';

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
  },

  s3: {
    audioBucket: process.env.S3_AUDIO_BUCKET || 'squadup-audio',
  },

  workers: {
    enabled: process.env.ENABLE_WORKERS !== 'false',
  },

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Use in-memory plans (no AWS credentials) — local Week 1 / Docker dev */
  devMemoryStore:
    process.env.DEV_MEMORY_STORE === 'true' ||
    (process.env.NODE_ENV === 'development' &&
      process.env.DEV_MEMORY_STORE !== 'false'),
};

module.exports = { config };
