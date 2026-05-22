'use strict';

const { logger } = require('../lib/logger');

/** @type {Array<{ jobId: string, userId: string, s3Key: string }>} */
const queue = [];
let draining = false;

function enqueueTranscription(job) {
  queue.push(job);
  logger.debug({ jobId: job.jobId, queueSize: queue.length }, 'voice job enqueued');
  drainQueue();
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const job = queue.shift();
    logger.info({ jobId: job.jobId }, 'voice job acknowledged (poll /voice/transcribe/:jobId)');
    // Transcribe runs in AWS; client polls GET /voice/transcribe/:jobId.
    // Extend here for push notifications or auto Bedrock when job completes.
  }

  draining = false;
}

function startVoiceProcessor() {
  logger.info('Voice processor worker ready');
}

module.exports = { enqueueTranscription, startVoiceProcessor };
