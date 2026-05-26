'use strict';

const { body, param, validationResult } = require('express-validator');

/** Cognito `sub` values are UUID-shaped but not always RFC-4122 v4. */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userIdField(field, location = 'body') {
  const chain = location === 'param' ? param(field) : body(field);
  return chain.matches(USER_ID_RE).withMessage('Invalid user id');
}

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

module.exports = { handleValidation, userIdField, USER_ID_RE };
