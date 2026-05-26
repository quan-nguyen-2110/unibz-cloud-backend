'use strict';

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { parse: parseUrl } = require('url');

const { config } = require('../lib/config');
const { logger } = require('../lib/logger');
const { issuer, jwksUri } = require('../middleware/auth');

const RS = '\u001e';
const clients = new Map();
let wss;

function initHub(server) {
  wss = new WebSocketServer({ server, path: '/hub/feed' });

  wss.on('connection', async (ws, req) => {
    let userId;
    try {
      const { query } = parseUrl(req.url, true);
      if (
        config.nodeEnv === 'development' &&
        query.devUserId &&
        typeof query.devUserId === 'string'
      ) {
        userId = query.devUserId;
      } else if (query.token) {
        userId = await verifyToken(query.token);
      } else {
        throw new Error('No token');
      }
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const connectionId = Math.random().toString(36).slice(2);
    clients.set(ws, { userId, connectionId });
    logger.info({ userId, connectionId, total: clients.size }, 'hub client connected');

    ws.once('message', (data) => {
      const msg = data.toString().replace(RS, '');
      try {
        const parsed = JSON.parse(msg);
        if (parsed.protocol && parsed.protocol !== 'json') {
          ws.close(4002, 'Unsupported protocol');
          return;
        }
      } catch {
        /* continue */
      }

      ws.send(`{}${RS}`);
      sendTo(ws, 'connected', { connectionId, message: 'Welcome to SquadUp Feed' });
    });

    ws.on('message', (data) => {
      const frames = data.toString().split(RS).filter(Boolean);
      for (const frame of frames) {
        try {
          handleClientMessage(ws, JSON.parse(frame));
        } catch {
          /* ignore malformed */
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ userId, total: clients.size }, 'hub client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ userId, err: err.message }, 'hub websocket error');
    });
  });

  setInterval(() => {
    for (const [ws] of clients) {
      if (ws.readyState === ws.OPEN) ws.send(`{"type":6}${RS}`);
    }
  }, 15_000);

  logger.info('FeedHub listening at /hub/feed');
}

function handleClientMessage(ws, msg) {
  if (msg.type === 6) {
    ws.send(`{"type":6}${RS}`);
    return;
  }
  if (msg.type === 1 && msg.target === 'ping') {
    sendTo(ws, 'pong', { ts: Date.now() });
  }
}

function broadcast(event, payload, exceptUserId) {
  const target = event.replace(/:([a-z])/g, (_, c) => c.toUpperCase());
  const frame = `${JSON.stringify({ type: 1, target, arguments: [payload] })}${RS}`;

  let sent = 0;
  for (const [ws, meta] of clients) {
    if (meta.userId === exceptUserId) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
      sent++;
    }
  }
  logger.debug({ target, sent }, 'hub broadcast');
}

function sendTo(ws, target, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(`${JSON.stringify({ type: 1, target, arguments: [payload] })}${RS}`);
}

function sendToUser(userId, target, payload) {
  for (const [ws, meta] of clients) {
    if (meta.userId === userId) sendTo(ws, target, payload);
  }
}

const jwksClient = config.cognito.userPoolId
  ? jwksRsa({ cache: true, jwksUri, jwksRequestsPerMinute: 10 })
  : null;

function verifyToken(token) {
  if (!jwksClient || !issuer) {
    return Promise.resolve('dev-user');
  }

  return new Promise((resolve, reject) => {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) return reject(new Error('Invalid token'));

    jwksClient.getSigningKey(decoded.header.kid, (err, key) => {
      if (err) return reject(err);
      jwt.verify(
        token,
        key.getPublicKey(),
        { algorithms: ['RS256'], issuer },
        (verifyErr, payload) => {
          if (verifyErr) return reject(verifyErr);
          resolve(payload.sub);
        }
      );
    });
  });
}

module.exports = { initHub, broadcast, sendTo, sendToUser };
