'use strict';

const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const { config } = require('./lib/config');
const { logger } = require('./lib/logger');
const { correlationId } = require('./middleware/correlationId');
const { authMiddleware } = require('./middleware/auth');

const authRoutes = require('./controllers/auth');
const plansRoutes = require('./controllers/plans');
const usersRoutes = require('./controllers/users');
const friendsRoutes = require('./controllers/friends');
const voiceRoutes = require('./controllers/voice');
const { initHub } = require('./hubs/feedHub');
const { startVoiceProcessor } = require('./workers/voiceProcessor');
const { startRecapSweep } = require('./workers/recapSweep');

const app = express();

app.use(
  helmet({ contentSecurityPolicy: false })
);
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Correlation-Id', 'X-Dev-User-Id'],
  })
);
app.use(compression());
app.use(correlationId);
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.correlationId,
    customProps: (req) => ({ correlationId: req.correlationId }),
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

function healthPayload() {
  return { status: 'ok', ts: new Date().toISOString() };
}

app.get('/healthz', (_req, res) => res.json(healthPayload()));
app.get('/health', (_req, res) => res.json(healthPayload()));

app.use('/auth', authRoutes);
app.use('/plans', authMiddleware, plansRoutes);
app.use('/users', authMiddleware, usersRoutes);
app.use('/friends', authMiddleware, friendsRoutes);
app.use('/voice', authMiddleware, voiceRoutes);

app.use((err, req, res, _next) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  logger.error({ err, correlationId: req.correlationId }, 'request error');
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const server = http.createServer(app);
initHub(server);

if (config.workers.enabled) {
  startVoiceProcessor();
  startRecapSweep();
}

server.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      region: config.awsRegion,
      plansTable: config.dynamo.plans,
      workers: config.workers.enabled,
    },
    'SquadUp API started'
  );
});

module.exports = { app, server };
