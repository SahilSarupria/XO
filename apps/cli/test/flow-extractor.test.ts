import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapabilityLayer, type DecisionTree } from '@xo/capability-layer';
import { ConnectorHost, MapVault, fileConnector } from '@xo/connectors';
import { unpackArchive } from '@xo/package-sdk';
import { workflowsFromLayer } from '@xo/workflow-ir';
import { RunStore, WorkflowRunner, type Escalation } from '@xo/workflow-runtime';
import { createCommand } from '../src/commands/compiler/create.js';
import { extractorFor, resolveExtractor } from '../src/commands/flow/extractor.js';
import { withTempDir } from './helpers.js';

const LOAN = fileURLToPath(new URL('../../../packages/compiler/test/fixtures/loan-desk-policy.md', import.meta.url));
const LOCAL = { XO_PROVIDER: 'ollama', XO_MODEL: 'local-model', XO_PROVIDER_BASE_URL: 'http://localhost:11434' };

async function loadPackage(tmp: string) {
  const out = join(tmp, 'pkg.xo');
  const res = await createCommand({ sources: [LOAN], name: 'desk', version: '1.0.0', out, sign: true });
  assert.equal(res.exitCode, 0, res.lines.join('\n'));
  const unpacked = await unpackArchive(new Uint8Array(await readFile(out)));
  assert.ok(unpacked.ok);
  const layer = createCapabilityLayer(unpacked.value, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
  const loaded = workflowsFromLayer(layer)!;
  return { component: loaded.component, trees: layer.decisionTrees() as readonly DecisionTree[] };
}
const idOf = (c: { workflows: { id: string }[] }, suffix: string) => c.workflows.find((w) => w.id.endsWith(suffix))!.id;

test('resolveExtractor uses the shared operator contract; XO_EXTRACTOR_* overrides; unconfigured or off-allowlist fails closed', () => {
  assert.equal(resolveExtractor({}).ok, false);
  assert.match((resolveExtractor({}) as { error: string }).error, /XO_MODEL/);
  assert.ok(resolveExtractor(LOCAL).ok);
  // extraction may use a different model than chat
  assert.ok(
    resolveExtractor({
      XO_PROVIDER: 'anthropic',
      XO_MODEL: 'chat-model',
      ANTHROPIC_API_KEY: 'k',
      XO_EXTRACTOR_PROVIDER: 'ollama',
      XO_EXTRACTOR_MODEL: 'small',
      XO_EXTRACTOR_BASE_URL: 'http://localhost:11434',
    }).ok,
  );
  // the chat model's missing key must not matter once extraction is overridden, and vice versa
  assert.equal(
    resolveExtractor({ XO_PROVIDER: 'ollama', XO_MODEL: 'm', XO_EXTRACTOR_PROVIDER: 'openai', XO_EXTRACTOR_MODEL: 'x' }).ok,
    false,
  );
  // request-forgery guard is the existing allowlist, not a second copy
  const off = resolveExtractor({ ...LOCAL, XO_PROVIDER_BASE_URL: 'https://evil.example.com' });
  assert.equal(off.ok, false);
  assert.match((off as { error: string }).error, /allowlist/);
  assert.equal(resolveExtractor({ ...LOCAL, XO_PROVIDER_BASE_URL: 'http://169.254.169.254' }).ok, false);
});

test('a model-free workflow gets no extractor and the environment is never even read', async () => {
  await withTempDir('xo-ex-free-', async (tmp) => {
    const { component } = await loadPackage(tmp);
    const reads: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => (reads.push(String(k)), undefined), ownKeys: () => (reads.push('<keys>'), []) }) as Record<
      string,
      string | undefined
    >;
    const r = extractorFor(component, idOf(component, '_structured'), spy);
    assert.ok(r.ok);
    assert.equal(r.value, undefined);
    assert.deepEqual(reads, [], 'the environment was read for a workflow that needs no model');
  });
});

test('a free-text workflow with no model configured is refused with an actionable message, and runs with one', async () => {
  await withTempDir('xo-ex-need-', async (tmp) => {
    const { component } = await loadPackage(tmp);
    const id = idOf(component, '_from_text');
    const none = extractorFor(component, id, {});
    assert.equal(none.ok, false);
    assert.match((none as { error: string }).error, /reads free text with a model, but none is configured/);
    const some = extractorFor(component, id, LOCAL);
    assert.ok(some.ok);
    assert.ok(some.value !== undefined);
  });
});

/** The local model, faked at the transport: it answers in Ollama's wire format with whatever the script says. */
function fakeLocalModel(answer: unknown) {
  const real = globalThis.fetch;
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(answer) }, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const NARRATIVE = 'Maria Silva asked to borrow a projector valued at $900. She showed her library card and has no overdue loans.';
const grounded = {
  facts: {
    library_card: { stated: true, value: true, quote: 'She showed her library card' },
    borrower_with_3_or_more_overdue: { stated: true, value: false, quote: 'has no overdue loans' },
    loan_usd: { stated: true, value: 900, quote: 'valued at $900' },
  },
};

test('end to end through the CLI resolver: grounded free text is decided by the compiled tree; ungrounded text ESCALATES with its code', async () => {
  await withTempDir('xo-ex-e2e-', async (tmp) => {
    const { component, trees } = await loadPackage(tmp);
    const id = idOf(component, '_from_text');
    const escalations: Escalation[] = [];
    const build = (dir: string) => {
      const ex = extractorFor(component, id, LOCAL);
      assert.ok(ex.ok && ex.value !== undefined);
      return new WorkflowRunner({
        component,
        workflowId: id,
        store: new RunStore(join(tmp, dir)),
        connectors: new ConnectorHost({
          component,
          policy: { connectors: { decision_records: { grant: ['write_record'] } } },
          implementations: {
            decision_records: fileConnector({ roots: { records: join(tmp, 'records') }, maxBytes: 65_536, createRoots: true }),
          },
          vault: new MapVault({}),
        }),
        trees: new Map(trees.map((t) => [t.id, t])),
        extractor: ex.value,
        onEscalate: (e) => void escalations.push(e),
      });
    };

    const ok = fakeLocalModel(grounded);
    try {
      const r = await build('runs-ok').start({ runId: 'e1', inputs: { case_id: 'T-1', narrative: NARRATIVE } });
      assert.equal(r.state, 'completed', JSON.stringify(r));
      assert.equal(r.outputs?.['decision'], 'approve');
      assert.equal(ok.calls.length, 1);
      assert.match(ok.calls[0]!.url, /^http:\/\/localhost:11434\/api\/chat$/);
      assert.ok(ok.calls[0]!.body.includes('projector valued at $900'), 'the narrative did not reach the model');
    } finally {
      ok.restore();
    }

    // the model claims a number the text never says: nothing is decided
    const bad = fakeLocalModel({ facts: { ...grounded.facts, loan_usd: { stated: true, value: 90, quote: 'valued at $90' } } });
    try {
      const r = await build('runs-bad').start({ runId: 'e2', inputs: { case_id: 'T-2', narrative: NARRATIVE } });
      assert.equal(r.state, 'escalated');
      assert.equal(escalations.at(-1)?.code, 'UNGROUNDED_FACT');
      assert.equal(r.outputs?.['decision'], undefined);
    } finally {
      bad.restore();
    }
  });
});

test('daily caps flags: strict integers only, off by default, persisted under the runs directory', async () => {
  const { capsFromFlags } = await import('../src/commands/flow/extractor.js');
  assert.equal((capsFromFlags({}, '/x') as { value: unknown }).value, undefined);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '10000000000', '1e3'])
    assert.equal(capsFromFlags({ 'daily-model-calls': bad }, '/x').ok, false, bad);
  assert.equal(capsFromFlags({ 'daily-effects': true }, '/x').ok, false);
  await withTempDir('xo-caps-', async (tmp) => {
    const r = capsFromFlags({ 'daily-model-calls': '2' }, tmp);
    assert.ok(r.ok && r.value !== undefined);
    assert.equal(await r.value.consume('modelCalls'), true);
    assert.equal(await r.value.consume('modelCalls'), true);
    assert.equal(await r.value.consume('modelCalls'), false, 'the cap did not hold');
    // a new process (new object) over the same directory sees the same counters: a restart cannot reset the cap
    const again = capsFromFlags({ 'daily-model-calls': '2' }, tmp);
    assert.ok(again.ok && again.value !== undefined);
    assert.equal(await again.value.consume('modelCalls'), false);
  });
});
