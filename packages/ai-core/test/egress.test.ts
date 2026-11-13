// UW-14a/b — residency modes and the typed egress boundary, enforced at the provider interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '@xo/errors';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import type { ModelProvider, ProviderRequest } from '../src/provider-types.js';
import { getInferenceDenial, InferenceGuard } from '../src/inference-policy.js';
import {
  buildEgressRequest,
  checkResidency,
  defineResponseSchema,
  defineTemplate,
  describeSchema,
  disclosableName,
  EgressBoundaryError,
  egressOf,
  filterIntent,
  guardProvider,
  isTypedEgressRequest,
  providerLocality,
  ResidencyConfigError,
  resolveResidency,
  synthesizeRecords,
  valueShape,
  type ResidencyPolicy,
} from '../src/egress/index.js';

const PLAN_SYSTEM = defineTemplate('test/plan-system', 'You turn a goal into a workflow over the described table. Answer in JSON.');
const PLAN_SCHEMA = defineResponseSchema('test/plan-response', {
  type: 'object',
  properties: { steps: { type: 'array' } },
  required: ['steps'],
});

const strict = resolveResidency({});
const masked = resolveResidency({ XO_RESIDENCY: 'masked_hosted', XO_HOSTED_MODEL_PROVIDERS: 'anthropic' });
const open = resolveResidency({ XO_RESIDENCY: 'open' });

/** A fetch that records every attempted connection and never connects: the network capture for UAC-25. */
function capture(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 1, model: 'm' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}

function recorder(id: string): ModelProvider & { seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  return {
    id,
    seen,
    describeCapabilities: () => ({
      providerId: id,
      models: ['m'],
      supportsStreaming: false,
      supportsStructuredOutput: true,
      supportsVision: true,
      maxContextTokens: 1,
    }),
    async complete(request) {
      seen.push(request);
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' };
    },
  };
}

const CLIENTS = {
  name: 'Clients',
  columns: [
    { header: 'Client name', type: 'string' },
    { header: 'Email', type: 'string' },
    { header: 'PAN', type: 'string' },
    { header: 'Policy no', type: 'integer' },
    { header: 'Renewal', type: 'date' },
    { header: 'Diabetic', type: 'boolean' },
    { header: '9876543210', type: 'string' }, // a header row that is really data: withheld
  ],
  rows: [
    ['Asha Rao', 'asha.rao@example.com', 'ABCDE1234F', 4471102, '2027-03-31', true, 'x'],
    ['Vikram Mehta', 'vikram.m@example.org', 'PQRSX9876K', 4471108, '2027-04-15', false, 'y'],
    ['Zoya Khan', 'zoya.khan@example.net', 'LMNOP5555Z', 4471111, '2027-05-01', false, 'z'],
  ],
};

test('residency: strict_local by default; masked_hosted needs a contracted provider list; open is refused in production', () => {
  assert.equal(strict.mode, 'strict_local');
  assert.throws(() => resolveResidency({ XO_RESIDENCY: 'masked_hosted' }), /needs XO_HOSTED_MODEL_PROVIDERS/);
  assert.throws(() => resolveResidency({ XO_RESIDENCY: 'open', NODE_ENV: 'production' }), ResidencyConfigError);
  assert.throws(() => resolveResidency({ XO_RESIDENCY: 'open', XO_ENV: 'production' }), /refused in production/);
  assert.throws(() => resolveResidency({ XO_RESIDENCY: 'cloud' }), /must be one of/);
  assert.deepEqual(masked.contractedProviders, ['anthropic']);
  assert.deepEqual(
    resolveResidency({ XO_HOSTED_MODEL_PROVIDERS: 'anthropic' }).contractedProviders,
    [],
    'a list means nothing outside masked_hosted',
  );
});

test('locality: only a model on this instance network is local; every unknown provider is hosted', () => {
  assert.equal(providerLocality('ollama'), 'local');
  for (const url of [
    'http://127.0.0.1:11434',
    'http://10.2.3.4:11434',
    'http://172.20.0.5:11434',
    'http://192.168.1.9',
    'http://ollama:11434',
    'http://gpu.internal',
    'http://host.docker.internal:11434',
    'http://[::1]:11434',
  ])
    assert.equal(providerLocality('ollama', url), 'local', url);
  for (const url of ['https://ollama.example.com', 'http://8.8.8.8:11434', 'http://172.32.0.1', 'not a url'])
    assert.equal(providerLocality('ollama', url), 'hosted', url);
  for (const id of ['anthropic', 'openai', 'gemini', 'azure-openai', 'fake']) assert.equal(providerLocality(id), 'hosted');
});

test('UAC-25: in strict_local a hosted provider makes no connection at all, for complete and stream; a local model works', async () => {
  const net = capture();
  const decisions: unknown[] = [];
  const anthropic = guardProvider(new AnthropicProvider({ apiKey: 'sk-ant-test-key-0000', fetchImpl: net.fetch }), strict, {
    onDecision: (d) => decisions.push(d),
  });
  const err = await anthropic
    .complete({ model: 'claude', messages: [{ role: 'user', content: 'Asha Rao, PAN ABCDE1234F' }], maxOutputTokens: 10 })
    .catch((e: unknown) => e);
  assert.equal((err as { code?: string }).code, ErrorCode.AI_INFERENCE_DENIED);
  assert.equal(getInferenceDenial(err)?.reason, 'residency_hosted_forbidden');
  assert.doesNotMatch(String((err as Error).message), /Asha|ABCDE/, 'the refusal never carries content');
  assert.deepEqual(net.urls, [], 'no connection was attempted');
  assert.deepEqual(decisions, [
    {
      providerId: 'anthropic',
      locality: 'hosted',
      mode: 'strict_local',
      typed: false,
      allowed: false,
      reason: 'residency_hosted_forbidden',
    },
  ]);
  assert.equal(egressOf(anthropic)?.rawAllowed, false);

  const local = guardProvider(new OllamaProvider({ fetchImpl: net.fetch }), strict);
  const r = await local.complete({ model: 'llama3', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 10 });
  assert.equal(r.text, 'ok');
  assert.match(net.urls[0]!, /^http:\/\/localhost:11434\//);
  const remote = guardProvider(new OllamaProvider({ baseUrl: 'https://ollama.example.com', fetchImpl: net.fetch }), strict, {
    endpoint: 'https://ollama.example.com',
  });
  await assert.rejects(remote.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 1 }), /strict_local/);
  assert.equal(net.urls.length, 1, 'an Ollama on someone else’s server is hosted');

  const streamer = guardProvider(
    {
      ...recorder('openai'),
      completeStream: async function* () {
        yield { type: 'text_delta', delta: 'leak' } as const;
      },
    },
    strict,
  );
  assert.throws(
    () => streamer.completeStream!({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 1 }),
    /strict_local/,
  );
});

test('masked_hosted: a contracted provider receives typed requests only; raw text, copies, images and other providers are refused', async () => {
  const anthropic = recorder('anthropic');
  const guarded = guardProvider(anthropic, masked);
  const schema = describeSchema(CLIENTS);
  const typed = buildEgressRequest({
    model: 'claude-sonnet',
    maxOutputTokens: 500,
    responseSchema: PLAN_SCHEMA,
    messages: [
      { role: 'system', parts: [PLAN_SYSTEM] },
      {
        role: 'user',
        parts: [
          schema,
          synthesizeRecords(schema, { count: 3, seed: 'plan-1' }),
          filterIntent('Email each client their renewal certificate a month before Renewal'),
        ],
      },
    ],
  });
  assert.equal(isTypedEgressRequest(typed), true);
  await guarded.complete(typed);
  assert.equal(anthropic.seen.length, 1);

  const raw: ProviderRequest = { model: 'claude-sonnet', messages: [{ role: 'user', content: 'Asha Rao' }], maxOutputTokens: 5 };
  assert.equal(getInferenceDenial(await guarded.complete(raw).catch((e: unknown) => e))?.reason, 'residency_untyped_egress');
  const copy = { ...typed, messages: [...typed.messages, { role: 'user' as const, content: 'and Asha Rao, ABCDE1234F' }] };
  assert.equal(
    getInferenceDenial(await guarded.complete(copy).catch((e: unknown) => e))?.reason,
    'residency_untyped_egress',
    'a modified copy is not typed',
  );
  assert.equal(
    getInferenceDenial(await guarded.complete({ ...typed }).catch((e: unknown) => e))?.reason,
    'residency_untyped_egress',
    'even an exact copy',
  );
  assert.throws(
    () => ((typed.messages as unknown as { content: string }[])[0]!.content = 'changed'),
    TypeError,
    'a typed request cannot be edited',
  );
  const withImage: ProviderRequest = {
    ...raw,
    messages: [{ role: 'user', content: 'read this', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }],
  };
  assert.equal(
    getInferenceDenial(await guarded.complete(withImage).catch((e: unknown) => e))?.reason,
    'residency_untyped_egress',
    'page images are never masked data',
  );
  const other = guardProvider(recorder('openai'), masked);
  assert.equal(getInferenceDenial(await other.complete(typed).catch((e: unknown) => e))?.reason, 'residency_provider_not_contracted');
  assert.equal(anthropic.seen.length, 1);

  const dev = guardProvider(recorder('openai'), open);
  await dev.complete(raw);
});

test('the boundary: no cell value reaches the request; names that look like values and names asked to be withheld are withheld', () => {
  const schema = describeSchema(CLIENTS, { withhold: ['Diabetic'] });
  const request = buildEgressRequest({
    model: 'm',
    maxOutputTokens: 1,
    messages: [{ role: 'user', parts: [schema, synthesizeRecords(schema, { count: 10, seed: 's' })] }],
  });
  const body = JSON.stringify(request);
  // Booleans are excluded: a synthetic true is a coincidence of form, not a copied value.
  for (const row of CLIENTS.rows)
    for (const v of row)
      if (typeof v !== 'boolean' && String(v).length >= 3) assert.ok(!body.includes(String(v)), `value ${String(v)} reached the request`);
  assert.deepEqual(
    schema.columns.map((c) => [c.name, c.withheld]),
    [
      ['Client name', false],
      ['Email', false],
      ['PAN', false],
      ['Policy no', false],
      ['Renewal', false],
      ['column_6', true],
      ['column_7', true],
    ],
  );
  assert.equal(schema.columns[2]!.shape, 'AAAAA9999A');
  assert.equal(schema.columns[3]!.shape, '9999999');
  assert.equal(schema.columns[0]!.shape, undefined, 'names of different lengths share no shape');
  assert.equal(schema.columns[1]!.length.min, 20);
  assert.equal(
    describeSchema(CLIENTS, { withhold: 'all' }).columns.every((c) => c.withheld),
    true,
  );
  for (const bad of ['asha@example.com', '4471102 policy', '', 'x'.repeat(65), '=HYPERLINK("evil")'])
    assert.equal(disclosableName(bad), false, bad);
  assert.equal(valueShape('Mehta-Rao, A.'), 'Aaaaa-Aaa, A.');
  assert.equal(valueShape('ü‮x'), 'a?a', 'bidi controls and other symbols never survive');
});

test('property: random real values in every cell never appear in a descriptor or its synthetic records', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const word = (n: number) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('');
  for (let trial = 0; trial < 40; trial++) {
    const cols = 1 + Math.floor(rnd() * 6);
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () =>
      Array.from({ length: cols }, (_, c) =>
        c % 3 === 0 ? `${word(4)} ${word(6)}` : c % 3 === 1 ? String(100000 + Math.floor(rnd() * 899999)) : `${word(5)}@${word(4)}.com`,
      ),
    );
    const source = {
      name: `Sheet ${trial}`,
      columns: Array.from({ length: cols }, (_, c) => ({ header: `Col ${c}`, type: c % 3 === 1 ? 'integer' : 'string' })),
      rows,
    };
    const schema = describeSchema(source);
    const body = JSON.stringify(
      buildEgressRequest({
        model: 'm',
        maxOutputTokens: 1,
        messages: [{ role: 'user', parts: [schema, synthesizeRecords(schema, { count: 5, seed: `t${trial}` })] }],
      }),
    );
    for (const r of rows) for (const v of r) assert.ok(!body.includes(v), `trial ${trial}: ${v} leaked`);
  }
});

test('nothing but minted parts can be sent: strings, look-alikes and synthetic records not made from a descriptor are refused', () => {
  const lookAlike = { kind: 'template', id: 'x', text: 'Asha Rao ABCDE1234F' } as never;
  assert.throws(
    () => buildEgressRequest({ model: 'm', maxOutputTokens: 1, messages: [{ role: 'user', parts: [lookAlike] }] }),
    EgressBoundaryError,
  );
  assert.throws(
    () => buildEgressRequest({ model: 'm', maxOutputTokens: 1, messages: [{ role: 'user', parts: ['raw text' as never] }] }),
    /did not come from the egress boundary/,
  );
  assert.throws(
    () => synthesizeRecords({ kind: 'schema', name: 'x', recordCount: 1, columns: [] } as never, { count: 1, seed: 's' }),
    /only from a schema descriptor/,
  );
  assert.throws(
    () =>
      buildEgressRequest({
        model: 'm',
        maxOutputTokens: 1,
        responseSchema: { kind: 'response-schema', id: 'x', schema: {} } as never,
        messages: [{ role: 'user', parts: [PLAN_SYSTEM] }],
      }),
    /defineResponseSchema/,
  );
  assert.throws(
    () => buildEgressRequest({ model: 'm', maxOutputTokens: 1, messages: [{ role: 'assistant' as never, parts: [PLAN_SYSTEM] }] }),
    /role/,
  );
  const schema = describeSchema(CLIENTS);
  assert.throws(
    () => ((schema.columns as unknown as { name: string }[])[0]!.name = 'Asha Rao'),
    TypeError,
    'a descriptor cannot be edited after minting',
  );
  assert.throws(() => defineTemplate('test/plan-system', 'again'), /defined twice/);
});

test('intent text: credentials, emails, links and digit runs are masked before it can be sent', () => {
  const i = filterIntent(
    'Send asha.rao@example.com the cert for policy 4471102 (call +91 98765 43210), see https://x.example/a?b=1, key AIzaSyA1234567890abcdefghijkl, by 2027',
  );
  assert.equal(i.text, 'Send [EMAIL] the cert for policy [NUMBER] (call [NUMBER]), see [URL] key [REDACTED], by 2027');
  assert.ok(i.replaced >= 5);
  assert.throws(() => filterIntent(' '), /empty/);
  assert.throws(() => filterIntent('x'.repeat(4001)), /longer than/);
});

test('fourth authority: the inference policy applies residency beside node, server and run', () => {
  const scope = (residency: ResidencyPolicy) => new InferenceGuard({ enabled: true, allowUndeclared: false, residency }).beginRun();
  const base = { requirement: 'required' as const, nodeId: 'n1', requestedMaxOutputTokens: 10 };
  assert.equal(scope(strict).checkPolicy({ ...base, providerId: 'gemini' })?.reason, 'residency_hosted_forbidden');
  assert.equal(scope(strict).checkPolicy({ ...base, providerId: 'ollama' }), undefined);
  assert.equal(scope(masked).checkPolicy({ ...base, providerId: 'anthropic' })?.reason, 'residency_untyped_egress');
  assert.equal(scope(masked).checkPolicy({ ...base, providerId: 'anthropic', egress: { locality: 'hosted', typed: true } }), undefined);
  assert.equal(checkResidency(open, { providerId: 'x', locality: 'hosted', typed: false }), undefined);
  assert.equal(
    new InferenceGuard().beginRun().checkPolicy({ ...base, providerId: 'gemini' }),
    undefined,
    'a policy without residency is unchanged',
  );
});

test('every defineTemplate / defineResponseSchema call in source code is at module level with literal text', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', 'test', '.git'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
        const lines = readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (
            !/\bdefine(Template|ResponseSchema)\(/.test(line) ||
            /function define(Template|ResponseSchema)/.test(line) ||
            line.trim().startsWith('*') ||
            line.trim().startsWith('//')
          )
            return;
          const literal = /^(export )?const \w+ = define(Template\('[^']+', ('[^'$]*'|`[^`$]*`|"[^"$]*")|ResponseSchema\('[^']+', \{)/.test(
            line.trim(),
          );
          if (!literal) offenders.push(`${p.slice(root.length)}:${i + 1}`);
        });
      }
    }
  };
  walk(join(root, 'packages'));
  walk(join(root, 'apps'));
  assert.deepEqual(offenders, [], 'templates must be top-level constants with literal text');
});
