import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from '../../src/providers/gemini-provider.js';

/**
 * OPT-IN live smoke test. Skipped unless BOTH are set:
 *   XO_LIVE_GEMINI_TEST=1   and   GEMINI_API_KEY=<your key>
 * Sends one tiny request (a few tokens). Never prints the key, prompt or response text.
 * Never runs in normal CI (no secrets there).
 */
const enabled = process.env['XO_LIVE_GEMINI_TEST'] === '1' && Boolean(process.env['GEMINI_API_KEY']);

test(
  'live: one tiny Gemini call succeeds and reports usage',
  { skip: enabled ? false : 'set XO_LIVE_GEMINI_TEST=1 and GEMINI_API_KEY to run' },
  async () => {
    const provider = new GeminiProvider({ apiKey: process.env['GEMINI_API_KEY'] as string, retry: { maxRetries: 1 } });
    const res = await provider.complete({
      model: process.env['XO_GEMINI_MODEL'] ?? GEMINI_DEFAULT_MODEL,
      maxOutputTokens: 512, // headroom: hidden reasoning tokens count against this budget
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    assert.ok(res.text.trim().length > 0);
    assert.equal(res.finishReason === 'stop' || res.finishReason === 'length', true);
    console.log(
      `live ok: model=${res.modelUsed} usageKnown=${String(res.usageKnown)} tokens=${res.usage.inputTokens}/${res.usage.outputTokens} attempts=${res.meta?.attempts}`,
    );
  },
);
