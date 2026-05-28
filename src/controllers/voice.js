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
const { logger } = require('../lib/logger');
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
  body('timezone').optional().isString().isLength({ max: 80 }),
  body('referenceNow').optional().isISO8601(),
  body('utcOffsetMinutes').optional().isInt({ min: -840, max: 840 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { transcript } = req.body;
      const parseCtx = buildParseContext(req.body);
      const parser = (config.voice.parser || 'bedrock').toLowerCase();
      let provider = parser;
      let parsed;

      try {
        if (parser === 'external') {
          parsed = await generateViaExternalLlm(transcript, parseCtx);
        } else if (parser === 'rule') {
          parsed = generateViaRuleBased(transcript, parseCtx);
        } else {
          parsed = await generateViaBedrock(transcript, parseCtx);
        }
      } catch (err) {
        if (parser !== 'external') throw err;
        logger.warn({ err }, 'external voice parser failed; using rule-based fallback');
        provider = 'rule-fallback';
        parsed = generateViaRuleBased(transcript, parseCtx);
      }

      res.json({
        plan: parsed.plan,
        meta: {
          provider,
          ...parsed.meta,
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

function buildParseContext(body = {}) {
  const ref = body.referenceNow ? new Date(body.referenceNow) : new Date();
  const referenceNow = Number.isNaN(ref.getTime()) ? new Date() : ref;
  const utcOffsetMinutes = Number.isFinite(body.utcOffsetMinutes)
    ? body.utcOffsetMinutes
    : 0;
  return {
    referenceNow,
    nowIso: referenceNow.toISOString(),
    utcOffsetMinutes,
    timezone: typeof body.timezone === 'string' ? body.timezone.trim() : '',
  };
}

function extractionPrompt(transcript, ctx) {
  const tzLine = ctx.timezone
    ? `- User timezone (IANA): ${ctx.timezone}`
    : `- UTC offset: ${ctx.utcOffsetMinutes} minutes`;
  return `You extract structured social plans for SquadUp from voice transcripts.

REFERENCE — use for every relative date/time (never invent years in the past):
- Now: ${ctx.nowIso}
${tzLine}

STRICT RULES:
1. startAt: ISO-8601 datetime with offset when the transcript states a date or time (e.g. "tomorrow at 7pm"). Resolve "tomorrow", "tonight", "7:00 p.m." relative to Now. If no date/time is stated, use null. Do not default to 7pm.
2. location: A real venue, business, address, or named place only. Use null for idioms ("at the door"), vague phrases ("somewhere", "here"), or when no real place was named.
3. maxPeople: Set only when the transcript explicitly gives a headcount (e.g. "for 6 people"). Otherwise use -1 (unlimited). Never guess a number.
4. title: Short catchy plan name (max 60 chars), not the full transcript.
5. description: One friendly sentence (max 180 chars).
6. vibeEmoji: Single emoji that best matches the activity.

Transcript: "${transcript}"

Return ONLY this JSON object (no markdown, no extra keys):
{
  "vibeEmoji": "single emoji",
  "title": "short plan title",
  "description": "one sentence",
  "startAt": "ISO-8601 with offset, or null",
  "location": "venue name or null",
  "maxPeople": -1 or integer 2-30
}`;
}

async function generateViaBedrock(transcript, ctx) {
  const prompt = extractionPrompt(transcript, ctx);
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
  const plan = parsePlanJson(rawText);
  const inputTokens = responseBody.usage?.input_tokens || 0;
  const outputTokens = responseBody.usage?.output_tokens || 0;
  const costUsd = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  return {
    plan: normalizePlan(plan, transcript, ctx),
    meta: {
      latencyMs,
      inputTokens,
      outputTokens,
      estimatedCostUsd: costUsd.toFixed(6),
      model: 'claude-3-haiku',
    },
  };
}

async function generateViaExternalLlm(transcript, ctx) {
  if (!config.voice.llmApiKey) {
    const err = new Error('VOICE_LLM_API_KEY is required for VOICE_PARSER=external');
    err.status = 500;
    throw err;
  }
  const t0 = Date.now();
  const response = await fetch(`${config.voice.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.voice.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.voice.llmModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a precise JSON extractor. Follow all rules in the user message. ' +
            'Never invent attendee counts, venues, or calendar years. Return valid JSON only.',
        },
        { role: 'user', content: extractionPrompt(transcript, ctx) },
      ],
    }),
    signal: AbortSignal.timeout(config.voice.llmTimeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`External LLM error: ${response.status}`);
    err.status = 502;
    err.detail = payload?.error || payload;
    throw err;
  }
  const rawText = payload?.choices?.[0]?.message?.content || '{}';
  const plan = normalizePlan(parsePlanJson(rawText), transcript, ctx);
  return {
    plan,
    meta: {
      latencyMs: Date.now() - t0,
      model: config.voice.llmModel,
      provider: 'openrouter',
      usage: payload?.usage || {},
    },
  };
}

function generateViaRuleBased(transcript, ctx) {
  const text = String(transcript || '').trim();
  const lower = text.toLowerCase();
  const mapped = inferVibe(lower);
  const maxPeople = inferMaxPeople(text);
  const locationName = inferLocation(text);
  return {
    plan: normalizePlan(
      {
        vibeEmoji: mapped.emoji,
        title: inferTitle(text, mapped.vibe),
        description: inferSummary(text),
        startAt: inferStartAtIso(lower, ctx.referenceNow),
        location: locationName,
        maxPeople,
      },
      text,
      ctx
    ),
    meta: {
      model: 'rule-based',
      heuristicVersion: 'v1',
    },
  };
}

function parsePlanJson(rawText) {
  try {
    return JSON.parse(String(rawText).replace(/```json|```/g, '').trim());
  } catch {
    const err = new Error('Could not parse AI response');
    err.status = 422;
    throw err;
  }
}

function normalizePlan(plan, transcript = '', ctx = buildParseContext()) {
  const text = String(transcript || '').trim();
  const lower = text.toLowerCase();
  const ref = ctx.referenceNow instanceof Date ? ctx.referenceNow : new Date();

  const maxPeopleRaw = Number.isFinite(plan?.maxPeople)
    ? plan.maxPeople
    : Number.isFinite(plan?.maxAttendees)
      ? plan.maxAttendees
      : -1;
  const emoji = typeof plan?.vibeEmoji === 'string' && plan.vibeEmoji.trim()
    ? plan.vibeEmoji.trim()
    : typeof plan?.emoji === 'string' && plan.emoji.trim()
      ? plan.emoji.trim()
      : '✨';
  const vibeEmoji = emoji;
  const vibeName =
    typeof plan?.vibeName === 'string' && plan.vibeName.trim()
      ? plan.vibeName.trim()
      : inferVibeNameFromEmoji(vibeEmoji);
  const titleRaw =
    typeof plan?.title === 'string' && plan.title.trim()
      ? plan.title.trim()
      : vibeName;
  const description =
    typeof plan?.description === 'string' && plan.description.trim()
      ? plan.description.trim()
      : typeof plan?.summary === 'string' && plan.summary.trim()
        ? plan.summary.trim()
        : inferSummary(text);
  const locationRaw =
    typeof plan?.location === 'string'
      ? plan.location.trim() || null
      : typeof plan?.location?.name === 'string'
        ? plan.location.name.trim() || null
        : null;
  const location = sanitizeLocation(locationRaw, lower);
  const startAt = normalizeStartAt(
    typeof plan?.startAt === 'string' ? plan.startAt : null,
    lower,
    ref
  );
  const maxPeople = sanitizeMaxPeople(maxPeopleRaw, text);
  return {
    vibeEmoji,
    vibeName: vibeName.slice(0, 40),
    title: titleRaw.slice(0, 60),
    description: description.slice(0, 180),
    startAt,
    location,
    maxPeople,
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function inferVibe(lowerText) {
  if (/(basketball|soccer|football|tennis|run|gym|hoops|swim|pool)/.test(lowerText)) {
    return { vibe: 'sport', emoji: '🏀' };
  }
  if (/(pizza|bbq|barbecue)/.test(lowerText)) {
    return { vibe: 'foodie', emoji: '🍕' };
  }
  if (/(coffee|cafe|brunch|dinner|lunch|food|restaurant)/.test(lowerText)) {
    return { vibe: 'foodie', emoji: '☕' };
  }
  if (/(study|library|homework|project|exam)/.test(lowerText)) {
    return { vibe: 'creative', emoji: '📖' };
  }
  if (/(game|gaming|mario|fifa|xbox|playstation|ps5|switch)/.test(lowerText)) {
    return { vibe: 'hype', emoji: '🎮' };
  }
  if (/(party|club|dance|concert)/.test(lowerText)) {
    return { vibe: 'hype', emoji: '🎉' };
  }
  return { vibe: 'chill', emoji: '✨' };
}

const INVALID_LOCATION_PHRASES =
  /^(the door|my place|your place|our place|somewhere|anywhere|here|there|outside|inside|tbd|home)$/i;

function inferLocation(text) {
  const m = text.match(/\b(?:at|in)\s+([A-Za-z0-9'&\-. ]{2,40})/i);
  if (!m) return null;
  const loc = m[1].replace(/[,.!?;:]+$/, '').trim();
  if (!loc || INVALID_LOCATION_PHRASES.test(loc)) return null;
  return loc;
}

function sanitizeLocation(location, lowerText) {
  if (!location) return null;
  const loc = location.trim();
  if (!loc || INVALID_LOCATION_PHRASES.test(loc)) return null;
  if (/^(at|in)\s+the\s+door\b/i.test(lowerText) && /^the door$/i.test(loc)) return null;
  return loc;
}

function inferMaxPeople(text) {
  const m =
    text.match(/\b(?:for|of|need|with)\s+(\d{1,2})\b/i) ||
    text.match(/\b(\d{1,2})\s*(?:people|friends|players|swimmers|ppl)\b/i);
  if (!m) return -1;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? clamp(n, 2, 30) : -1;
}

function extractTimeFromText(lowerText) {
  const m = lowerText.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i
  );
  if (!m) return null;
  let hours = Number.parseInt(m[1], 10);
  const minutes = m[2] ? Number.parseInt(m[2], 10) : 0;
  const meridiem = (m[3] || '').toLowerCase();
  if (meridiem.startsWith('p') && hours < 12) hours += 12;
  if (meridiem.startsWith('a') && hours === 12) hours = 0;
  if (!meridiem && hours >= 1 && hours <= 11 && /(evening|tonight|night|pm|p\.m)/.test(lowerText)) {
    hours += 12;
  }
  return { hours, minutes };
}

function inferStartAtIso(lowerText, referenceNow = new Date()) {
  const ref = referenceNow instanceof Date ? referenceNow : new Date(referenceNow);
  if (!/(tomorrow|tonight|this evening|today|in an hour|in 1 hour|\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?))/i.test(
    lowerText
  )) {
    return null;
  }

  const d = new Date(ref);
  if (/tomorrow/.test(lowerText)) {
    d.setDate(d.getDate() + 1);
  } else if (/(in an hour|in 1 hour)/.test(lowerText)) {
    d.setMinutes(d.getMinutes() + 60);
    return d.toISOString();
  }

  const time = extractTimeFromText(lowerText);
  if (time) {
    d.setHours(time.hours, time.minutes, 0, 0);
    return d.toISOString();
  }

  if (/(tonight|this evening)/.test(lowerText)) {
    d.setHours(20, 0, 0, 0);
    return d.toISOString();
  }
  if (/tomorrow/.test(lowerText)) {
    d.setHours(19, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

function reconcileRelativeDate(parsed, lowerText, ref) {
  const d = new Date(ref);
  if (/tomorrow/.test(lowerText)) {
    d.setDate(d.getDate() + 1);
  } else if (/(tonight|this evening|today)/.test(lowerText)) {
    // keep ref calendar day
  } else {
    return parsed;
  }
  d.setHours(parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(), 0);
  return d;
}

function inferSummary(text) {
  if (!text.trim()) return 'Quick plan generated from voice input.';
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function inferTitle(text, vibeLabel) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return 'New plan';
  const short = trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
  if (/^i want to /i.test(short)) {
    return short.replace(/^i want to /i, '').trim() || vibeLabel || 'New plan';
  }
  return short;
}

function normalizeStartAt(startAt, lowerText, referenceNow) {
  const ref = referenceNow instanceof Date ? referenceNow : new Date(referenceNow);
  const refMs = ref.getTime();

  if (startAt) {
    let parsed = new Date(startAt);
    if (!Number.isNaN(parsed.getTime())) {
      if (parsed.getTime() <= refMs && /tomorrow|tonight|today|this evening/i.test(lowerText)) {
        parsed = reconcileRelativeDate(parsed, lowerText, ref);
      }
      const time = extractTimeFromText(lowerText);
      if (time) {
        parsed.setHours(time.hours, time.minutes, 0, 0);
      }
      if (parsed.getTime() > refMs) return parsed.toISOString();
    }
  }

  return inferStartAtIso(lowerText, ref);
}

function sanitizeMaxPeople(value, transcript) {
  const fromText = inferMaxPeople(transcript);
  if (fromText >= 0) return fromText;
  if (!Number.isFinite(value) || value < 0) return -1;
  return -1;
}

function inferVibeNameFromEmoji(emoji) {
  const map = new Map([
    ['🏀', 'Sports'],
    ['🏊', 'Swimming'],
    ['☕', 'Coffee'],
    ['📖', 'Study'],
    ['🎮', 'Gaming'],
    ['🌳', 'Outdoors'],
    ['🎬', 'Movies'],
    ['🎉', 'Party'],
    ['✨', 'Hangout'],
  ]);
  return map.get(emoji) || 'Custom vibe';
}

function normalizeMaxPeople(value) {
  if (!Number.isFinite(value)) return -1;
  if (value < 0) return -1;
  return clamp(value, 2, 30);
}

module.exports = router;
