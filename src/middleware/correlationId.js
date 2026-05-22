'use strict';

const { randomUUID } = require('crypto');

function correlationId(req, res, next) {
  const id = req.headers['x-correlation-id'] || randomUUID();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}

module.exports = { correlationId };
