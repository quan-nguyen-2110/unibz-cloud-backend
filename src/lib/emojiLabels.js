'use strict';

const { invokeClaudeJson } = require('./bedrockJson');
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
const cache = new Map(Object.entries({ ...FALLBACK_LABELS, ...BUILTIN_LABELS }));

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
    for (const emoji of missing) {
      const label = sanitizeLabel(data[emoji]) || fallbackLabel(emoji);
      cache.set(emoji, label);
      result[emoji] = label;
    }
    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'Bedrock vibe labels unavailable; using fallbacks');
    for (const emoji of missing) {
      const label = fallbackLabel(emoji);
      cache.set(emoji, label);
      result[emoji] = label;
    }
    return result;
  }
}

function fallbackLabel(emoji) {
  return FALLBACK_LABELS[emoji] || 'Social';
}

module.exports = { resolveEmojiLabels, BUILTIN_LABELS };
