import { buildEgressRequest, describeSchema, guardProvider, resolveResidency, synthesizeRecords, type ModelProvider } from '@xo/ai-core';
import { contentHash, type Suite, type SuiteResult } from '../src/index.js';

/**
 * UW-14b — the typed egress boundary, measured: over many seeded random tables, how many real cell values reach a request a hosted
 * model would receive (must be none), and how many hosted calls a strict_local instance lets through (must be none).
 */
export const egressBoundarySuite: Suite = {
  id: 'egress-boundary',
  title: 'Keeping real values out of model requests',
  async run(): Promise<SuiteResult> {
    let seed = 20261113;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const word = (n: number) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('');
    const tables = 200;
    let values = 0;
    let leaked = 0;
    const fingerprint: string[] = [];
    for (let t = 0; t < tables; t++) {
      const cols = 1 + Math.floor(rnd() * 6);
      const rows = Array.from({ length: 2 + Math.floor(rnd() * 25) }, () =>
        Array.from({ length: cols }, (_, c) =>
          c % 4 === 0
            ? `${word(4)} ${word(7)}`
            : c % 4 === 1
              ? String(100000 + Math.floor(rnd() * 899999))
              : c % 4 === 2
                ? `${word(5)}@${word(6)}.in`
                : `${word(5).toUpperCase()}${Math.floor(1000 + rnd() * 8999)}${word(1).toUpperCase()}`,
        ),
      );
      fingerprint.push(contentHash(rows));
      const schema = describeSchema({
        name: `Sheet ${t}`,
        columns: Array.from({ length: cols }, (_, c) => ({ header: `Field ${c}`, type: c % 4 === 1 ? 'integer' : 'string' })),
        rows,
      });
      const body = JSON.stringify(
        buildEgressRequest({
          model: 'm',
          maxOutputTokens: 1,
          messages: [{ role: 'user', parts: [schema, synthesizeRecords(schema, { count: 5, seed: `t${t}` })] }],
        }),
      );
      for (const r of rows)
        for (const v of r) {
          values++;
          if (body.includes(v)) leaked++;
        }
    }
    let reached = 0;
    const hosted: ModelProvider = {
      id: 'anthropic',
      describeCapabilities: () => ({
        providerId: 'anthropic',
        models: ['m'],
        supportsStreaming: false,
        supportsStructuredOutput: true,
        supportsVision: true,
        maxContextTokens: 1,
      }),
      complete: async () => {
        reached++;
        return { text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: 'm', finishReason: 'stop' };
      },
    };
    const guarded = guardProvider(hosted, resolveResidency({}));
    const attempts = 50;
    for (let i = 0; i < attempts; i++)
      await guarded
        .complete({ model: 'm', messages: [{ role: 'user', content: `value ${i}` }], maxOutputTokens: 1 })
        .catch(() => undefined);
    return {
      suite: 'egress-boundary',
      title: 'Keeping real values out of model requests',
      uac: ['UAC-24', 'UAC-25'],
      mode: 'deterministic',
      sets: [
        {
          id: 'egress-random-tables',
          version: '1',
          provenance: 'synthetic',
          cases: tables,
          contentHash: contentHash(fingerprint),
          description: 'Seeded random tables of names, ids, emails and PAN-shaped values.',
        },
      ],
      measures: [
        {
          id: 'egress-boundary/leaked-values',
          title: 'Real cell values found in a typed request',
          unit: 'count',
          better: 'lower',
          value: leaked,
          numerator: leaked,
          denominator: values,
        },
        {
          id: 'egress-boundary/strict-local-hosted-calls',
          title: 'Hosted calls reaching the provider in strict_local',
          unit: 'count',
          better: 'lower',
          value: reached,
          numerator: reached,
          denominator: attempts,
        },
      ],
      notes: [],
      limits: [
        'Covers the schema-descriptor and synthetic-record channels only. The canary test across every input channel (cells, file and folder names, PDF text, prompts, error paths) is UW-14e (UAC-24).',
        'Measures the boundary in-process; network capture of the running instance is in apps/api/test/residency.test.ts.',
      ],
    };
  },
};
