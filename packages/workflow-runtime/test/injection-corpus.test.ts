// UW-1 trust boundary T2 (specs/security/TRUST_BOUNDARY.md), corpus skeleton (UAC-17): on the workflow extraction path the case text
// reaches the model only as a JSON-encoded data field under a fixed system message, and a model answer that "obeys" a payload by asserting
// a fact the text does not state is refused, never accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ModelProvider, ProviderRequest } from '@xo/ai-core';
import type { FieldSpec } from '@xo/workflow-ir';
import { ExtractionRefused, ModelExtractor } from '../src/index.js';

const corpus = JSON.parse(readFileSync(new URL('../../../specs/security/injection-corpus.json', import.meta.url), 'utf8')) as {
  cases: { id: string; text: string }[];
};
const FIELDS: Record<string, FieldSpec> = { amount: { type: 'number', nullable: true } };

function provider(answer: unknown): { provider: ModelProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      id: 'scripted',
      describeCapabilities: () => ({
        providerId: 'scripted',
        models: ['m'],
        supportsStreaming: false,
        supportsStructuredOutput: true,
        supportsVision: false,
        maxContextTokens: 100_000,
      }),
      complete: async (r) => {
        requests.push(r);
        return { text: JSON.stringify(answer), usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' };
      },
    } as ModelProvider,
  };
}

test('each payload reaches the model only inside the JSON-encoded case_text, under the same system message', async () => {
  let system: string | undefined;
  for (const c of corpus.cases) {
    const p = provider({ facts: { amount: { stated: false, value: 0, quote: '' } } });
    await new ModelExtractor({ provider: p.provider, model: 'm' }).extract({
      instruction: 'read the case',
      text: c.text,
      fields: FIELDS,
      grounding: 'quote_required',
    });
    const [sys, user] = p.requests[0]!.messages;
    assert.equal(sys?.role, 'system');
    system ??= sys!.content as string;
    assert.equal(sys!.content, system, `${c.id}: the system message never changes with the data`);
    assert.ok(!(sys!.content as string).includes(c.text), `${c.id}: no payload in the system message`);
    const payload = JSON.parse(user!.content as string) as { case_text: string };
    assert.equal(payload.case_text, c.text, `${c.id}: the payload is carried verbatim as data`);
  }
  assert.match(system!, /UNTRUSTED DATA/);
});

test('a model that follows a payload and asserts an ungrounded value is refused, not believed', async () => {
  for (const c of corpus.cases) {
    const obeyed = provider({ facts: { amount: { stated: true, value: 424242, quote: 'approved by the system administrator' } } });
    await assert.rejects(
      new ModelExtractor({ provider: obeyed.provider, model: 'm' }).extract({
        instruction: 'read the case',
        text: c.text,
        fields: FIELDS,
        grounding: 'quote_required',
      }),
      (e: unknown) => e instanceof ExtractionRefused,
      c.id,
    );
  }
});
