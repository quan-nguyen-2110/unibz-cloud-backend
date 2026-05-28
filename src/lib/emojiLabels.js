'use strict';

const { invokeClaudeJson } = require('./bedrockJson');
const { config } = require('./config');
const { logger } = require('./logger');

/** Built-in labels (same as Flutter catalog); no Bedrock call. */
const BUILTIN_LABELS = {
  '🏀': 'Hoops',
  '🏊': 'Swim',
  '☕': 'Cafe',
  '📖': 'Study',
  '🎮': 'Gaming',
};

/** Used when Bedrock is unavailable (e.g. Learner Lab LabRole). */
const FALLBACK_LABELS = {
  '🎬': 'Movies',
  '🥊': 'Boxing',
  '🎳': 'Bowling',
  '🎵': 'Music',
  '🍇': 'Snacks',
  '🔥': 'Hype',
  '🏄': 'Surf',
  '🍻': 'Drinks',
  '🦄': 'Magic',
  '🎉': 'Party',
  '🎯': 'Games',
  '✨': 'Vibes',
  '🏃': 'Running',
  '🍫': 'Treats',
  '🐱': 'Pets',
  '🐶': 'Pets',
  '🎨': 'Art',
  '🏐': 'Volley',
  '🍕': 'Pizza',
  '🥾': 'Hiking',
  '🏖': 'Beach',
  '🧘': 'Yoga',
  '🚲': 'Cycling',
  '🌴': 'Tropical',
  '⛹': 'Ballers',
  '📝': 'Notes',
  '🛹': 'Skate',
  '🎊': 'Celebrate',
  '🍟': 'Food',
  '📷': 'Photos',
  '🏋': 'Gym',
  '📚': 'Books',
  '🎾': 'Tennis',
  '⚽': 'Soccer',
  '🏀': 'Hoops',
  '🏊': 'Swim',
};

/** @type {Map<string, string>} */
const cache = new Map(Object.entries(BUILTIN_LABELS));

function normalizeEmoji(value) {
  return String(value || '').trim();
}

function sanitizeLabel(value) {
  const label = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 14);
  return label;
}

/**
 * @param {string[]} emojis
 * @returns {Promise<Record<string, string>>}
 */
async function resolveEmojiLabels(emojis) {
  const unique = [...new Set(emojis.map(normalizeEmoji).filter(Boolean))];
  const result = {};
  const missing = [];

  for (const emoji of unique) {
    const cached = cache.get(emoji);
    if (cached) {
      result[emoji] = cached;
    } else {
      missing.push(emoji);
    }
  }

  if (missing.length === 0) return result;

  const emojiList = missing.join(', ');
  const prompt = `You label emoji for filter chips on a social plans app (SquadUp).
For each emoji below, return a short English name (1–2 words, max 12 characters) suitable next to the emoji on a button.
Use title case (e.g. "Morning Run", "Open Mic"). Be specific and friendly, not generic.

Emojis: ${emojiList}

Respond ONLY with valid JSON — an object whose keys are the exact emoji characters and values are the labels:
{ "🏀": "Hoops", "🎬": "Open Mic" }`;

  try {
    const { data } = await invokeClaudeJson(prompt);
    applyLabels(result, missing, data);
    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'Bedrock vibe labels unavailable; trying OpenRouter');
  }

  try {
    const data = await invokeOpenRouterJson(prompt);
    applyLabels(result, missing, data);
    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenRouter vibe labels unavailable; using built-in fallback');
    for (const emoji of missing) {
      const label = fallbackLabel(emoji);
      cache.set(emoji, label);
      result[emoji] = label;
    }
    return result;
  }
}

function applyLabels(result, emojis, data) {
  for (const emoji of emojis) {
    const label = sanitizeLabel(data?.[emoji]) || fallbackLabel(emoji);
    cache.set(emoji, label);
    result[emoji] = label;
  }
}

async function invokeOpenRouterJson(prompt) {
  if (!config.voice.llmApiKey) {
    throw new Error('VOICE_LLM_API_KEY missing');
  }
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
        { role: 'system', content: 'Return valid JSON only. No markdown.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(config.voice.llmTimeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.status}`);
  }
  const rawText = payload?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(String(rawText).replace(/```json|```/g, '').trim());
}

function fallbackLabel(emoji) {
  return FALLBACK_LABELS[emoji] || 'Social';
}

module.exports = { resolveEmojiLabels, BUILTIN_LABELS };
