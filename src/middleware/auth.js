'use strict';

const { expressjwt: expressJwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const { config } = require('../lib/config');
const { logger } = require('../lib/logger');

const { userPoolId } = config.cognito;
const region = config.awsRegion;

if (!userPoolId) {
  logger.warn('COGNITO_USER_POOL_ID not set — using development auth bypass');
}

const issuer = userPoolId
  ? `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`
  : null;

const jwksUri = issuer ? `${issuer}/.well-known/jwks.json` : null;

function getToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  if (req.query?.token) return req.query.token;
  return null;
}

const cognitoJwt = userPoolId
  ? expressJwt({
      secret: jwksRsa.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri,
      }),
      algorithms: ['RS256'],
      issuer,
      getToken,
    })
  : null;

/** Validates Cognito JWT; in development without pool id, accepts X-Dev-User-Id header. */
function authMiddleware(req, res, next) {
  if (cognitoJwt) return cognitoJwt(req, res, next);

  const devUserId = req.headers['x-dev-user-id'];
  if (config.nodeEnv === 'development' && devUserId) {
    req.auth = { sub: devUserId };
    return next();
  }

  return res.status(503).json({
    error: 'Auth not configured — set COGNITO_USER_POOL_ID or use X-Dev-User-Id in development',
  });
}

function getUserId(req) {
  return req.auth?.sub;
}

module.exports = { authMiddleware, getUserId, getToken, issuer, jwksUri };
