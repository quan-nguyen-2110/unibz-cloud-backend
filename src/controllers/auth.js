'use strict';

const express = require('express');
const { body } = require('express-validator');
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');

const { ddb } = require('../services/dynamo');
const { config } = require('../lib/config');
const { handleValidation } = require('../lib/validate');

const router = express.Router();

const cognito = new CognitoIdentityProviderClient({ region: config.awsRegion });
const { clientId } = config.cognito;
const USERS_TABLE = config.dynamo.users;

router.post(
  '/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('username').trim().isAlphanumeric().isLength({ min: 3, max: 30 }),
  body('displayName').trim().isLength({ min: 1, max: 50 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { email, password, username, displayName } = req.body;

      const signUpResult = await cognito.send(
        new SignUpCommand({
          ClientId: clientId,
          Username: email,
          Password: password,
          UserAttributes: [{ Name: 'email', Value: email }],
        })
      );

      const userId = signUpResult.UserSub;

      await ddb.send(
        new PutCommand({
          TableName: USERS_TABLE,
          Item: {
            userId,
            username,
            displayName,
            email,
            avatarUrl: null,
            bio: '',
            createdAt: new Date().toISOString(),
            confirmed: false,
          },
          ConditionExpression: 'attribute_not_exists(userId)',
        })
      );

      res.status(201).json({
        message: 'User created — check email for confirmation code',
        userId,
        confirmed: signUpResult.UserConfirmed,
      });
    } catch (err) {
      if (err.name === 'UsernameExistsException') {
        return res.status(409).json({ error: 'Email already registered' });
      }
      next(err);
    }
  }
);

router.post(
  '/confirm',
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }),
  handleValidation,
  async (req, res, next) => {
    try {
      await cognito.send(
        new ConfirmSignUpCommand({
          ClientId: clientId,
          Username: req.body.email,
          ConfirmationCode: req.body.code,
        })
      );
      res.json({ message: 'Email confirmed — you can now log in' });
    } catch (err) {
      if (err.name === 'CodeMismatchException') {
        return res.status(400).json({ error: 'Invalid confirmation code' });
      }
      next(err);
    }
  }
);

router.post(
  '/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  handleValidation,
  async (req, res, next) => {
    try {
      const result = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: {
            USERNAME: req.body.email,
            PASSWORD: req.body.password,
          },
        })
      );

      const tokens = result.AuthenticationResult;
      res.json({
        accessToken: tokens.AccessToken,
        idToken: tokens.IdToken,
        refreshToken: tokens.RefreshToken,
        expiresIn: tokens.ExpiresIn,
      });
    } catch (err) {
      if (['NotAuthorizedException', 'UserNotFoundException'].includes(err.name)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      if (err.name === 'UserNotConfirmedException') {
        return res.status(403).json({ error: 'Email not confirmed' });
      }
      next(err);
    }
  }
);

router.post(
  '/refresh',
  body('refreshToken').notEmpty(),
  handleValidation,
  async (req, res, next) => {
    try {
      const result = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          ClientId: clientId,
          AuthParameters: { REFRESH_TOKEN: req.body.refreshToken },
        })
      );

      const tokens = result.AuthenticationResult;
      res.json({
        accessToken: tokens.AccessToken,
        idToken: tokens.IdToken,
        expiresIn: tokens.ExpiresIn,
      });
    } catch (err) {
      if (err.name === 'NotAuthorizedException') {
        return res.status(401).json({ error: 'Refresh token expired' });
      }
      next(err);
    }
  }
);

router.post(
  '/resend-code',
  body('email').isEmail().normalizeEmail(),
  handleValidation,
  async (req, res, next) => {
    try {
      await cognito.send(
        new ResendConfirmationCodeCommand({
          ClientId: clientId,
          Username: req.body.email,
        })
      );
      res.json({ message: 'Code resent' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
