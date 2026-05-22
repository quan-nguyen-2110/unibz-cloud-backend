'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { config } = require('../lib/config');

const rawClient = new DynamoDBClient({
  region: config.awsRegion,
  // endpoint: 'http://localhost:8000', // DynamoDB Local
});

const ddb = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    convertEmptyValues: false,
    removeUndefinedValues: true,
  },
});

module.exports = { ddb };
