'use strict';

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const { config } = require('./config');

const bedrock = new BedrockRuntimeClient({ region: config.awsRegion });
const DEFAULT_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';

/**
 * @param {string} prompt
 * @param {{ maxTokens?: number, modelId?: string }} [opts]
 * @returns {Promise<{ text: string, usage: object, latencyMs: number }>}
 */
async function invokeClaudeText(prompt, opts = {}) {
  const t0 = Date.now();
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: opts.modelId || DEFAULT_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: opts.maxTokens ?? 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  );
  const latencyMs = Date.now() - t0;
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text || '';
  return { text, usage: responseBody.usage || {}, latencyMs };
}

/**
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function invokeClaudeJson(prompt) {
  const { text, usage, latencyMs } = await invokeClaudeText(prompt, { maxTokens: 1024 });
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return { data: JSON.parse(cleaned), usage, latencyMs };
  } catch {
    const err = new Error('Could not parse AI JSON response');
    err.status = 422;
    err.raw = text;
    throw err;
  }
}

module.exports = { invokeClaudeText, invokeClaudeJson };
