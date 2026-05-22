'use strict';

const cron = require('node-cron');
const { logger } = require('../lib/logger');

function startRecapSweep() {
  // Every hour — patch ended plans with recapUrl (Week 3 optional feature)
  cron.schedule('0 * * * *', () => {
    logger.debug('recap sweep tick (not yet implemented)');
    // TODO: query Plans GSI for status=completed, render recap → S3, update recapUrl
  });

  logger.info('Recap sweep worker scheduled (hourly stub)');
}

module.exports = { startRecapSweep };
