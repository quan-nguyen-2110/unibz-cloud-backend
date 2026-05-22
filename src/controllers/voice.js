'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const { getUserId } = require('../middleware/auth');
const { config } = require('../lib/config');
const { handleValidation } = require('../lib/validate');
const { enqueueTranscription } = require('../workers/voiceProcessor');

const router = express.Router();
const REGION = config.awsRegion;
const AUDIO_BUCKET = config.s3.audioBucket;

const s3 = new S3Client({ region: REGION });
const transcribe = new TranscribeClient({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });

router.post(
  '/presign',
  body('contentType').isIn(['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm']),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const fileId = uuidv4();
      const ext = req.body.contentType.split('/')[1].replace('mpeg', 'mp3');
      const s3Key = `voice/${userId}/${fileId}.${ext}`;
      const expiresIn = 300;

      const command = new PutObjectCommand({
        Bucket: AUDIO_BUCKET,
        Key: s3Key,
        ContentType: req.body.contentType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn });

      res.json({
        uploadUrl,
        s3Key,
        fileId,
        expiresIn,
        instructions: 'PUT audio to uploadUrl, then POST /voice/transcribe',
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/transcribe',
  body('s3Key').isString().notEmpty(),
  body('languageCode').optional().isIn(['en-US', 'en-GB', 'es-US', 'fr-FR', 'de-DE', 'it-IT']),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const jobName = `squadup-${userId}-${Date.now()}`;

      await transcribe.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: req.body.languageCode || 'en-US',
          MediaFormat: req.body.s3Key.split('.').pop(),
          Media: { MediaFileUri: `s3://${AUDIO_BUCKET}/${req.body.s3Key}` },
          OutputBucketName: AUDIO_BUCKET,
          OutputKey: `transcripts/${jobName}.json`,
          Settings: {
            ShowSpeakerLabels: false,
            EnableAutomaticPunctuation: true,
          },
        })
      );

      enqueueTranscription({ jobId: jobName, userId, s3Key: req.body.s3Key });

      res.status(202).json({
        jobId: jobName,
        status: 'IN_PROGRESS',
        message: 'Poll GET /voice/transcribe/:jobId for result',
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/transcribe/:jobId',
  param('jobId').isString().notEmpty(),
  handleValidation,
  async (req, res, next) => {
    try {
      const result = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: req.params.jobId })
      );

      const job = result.TranscriptionJob;
      const status = job.TranscriptionJobStatus;

      if (status === 'FAILED') {
        return res.status(422).json({ error: 'Transcription failed', reason: job.FailureReason });
      }
      if (status === 'IN_PROGRESS') {
        return res.json({ status, message: 'Still processing — try again in 5s' });
      }

      const s3result = await s3.send(
        new GetObjectCommand({
          Bucket: AUDIO_BUCKET,
          Key: `transcripts/${req.params.jobId}.json`,
        })
      );

      const raw = await streamToString(s3result.Body);
      const transcript = JSON.parse(raw);
      const text = transcript.results?.transcripts?.[0]?.transcript || '';

      res.json({ status: 'COMPLETED', transcript: text });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/generate-plan',
  body('transcript').isString().notEmpty().isLength({ max: 2000 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { transcript } = req.body;

      const prompt = `You are a plan extractor for a social app called SquadUp.
Given a voice transcript, extract a spontaneous social plan and respond ONLY with valid JSON.

Transcript: "${transcript}"

Respond with this exact JSON shape (no markdown, no explanation):
{
  "title": "short catchy plan title (max 60 chars)",
  "emoji": "single relevant emoji",
  "vibe": "one of: chill | hype | foodie | sport | creative | other",
  "location": { "name": "place name if mentioned, else null" },
  "maxAttendees": number or 10 if not mentioned,
  "expiresInMinutes": 60 to 240 based on urgency (default 120),
  "summary": "one sentence describing the vibe"
}`;

      const t0 = Date.now();
      const response = await bedrock.send(
        new InvokeModelCommand({
          modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
        })
      );
      const latencyMs = Date.now() - t0;

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const rawText = responseBody.content?.[0]?.text || '{}';

      let plan;
      try {
        plan = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      } catch {
        return res.status(422).json({ error: 'Could not parse AI response', raw: rawText });
      }

      const inputTokens = responseBody.usage?.input_tokens || 0;
      const outputTokens = responseBody.usage?.output_tokens || 0;
      const costUsd = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;

      res.json({
        plan,
        meta: {
          latencyMs,
          inputTokens,
          outputTokens,
          estimatedCostUsd: costUsd.toFixed(6),
          model: 'claude-3-haiku',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

module.exports = router;
