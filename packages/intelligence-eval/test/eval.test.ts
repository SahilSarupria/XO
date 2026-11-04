import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '@xo/types';
import type { AiError } from '@xo/errors';
import type { ConversationModel } from '@xo/intelligence';
import {
  CATEGORIES,
  CORPUS,
  DATASET,
  LeakyKnowledgePort,
  OracleModel,
  PERSONAS,
  buildReport,
  renderMarkdown,
  runEval,
  type EvalItem,
} from '../src/index.js';

const run = (model: ConversationModel, items: readonly EvalItem[] = DATASET, knowledge?: () => LeakyKnowledgePort) =>
  runEval({ model, items, ...(knowledge ? { knowledge } : {}) }).then((results) => ({
    results,
    report: buildReport(results, { mode: 'oracle', model: 'test', knowledgeSource: 'test' }),
  }));

// ------------------------------------------------------------------------------------------------ the dataset itself

test('dataset: at least 50 items, every category covered, unique ids and messages', () => {
  assert.ok(DATASET.length >= 50, `${DATASET.length} items`);
  for (const c of CATEGORIES)
    assert.ok(
      DATASET.some((i) => i.category === c),
      `no ${c} items`,
    );
  assert.equal(new Set(DATASET.map((i) => i.id)).size, DATASET.length, 'duplicate ids');
  assert.equal(new Set(DATASET.map((i) => i.message)).size, DATASET.length, 'duplicate messages (the reference model keys on them)');
});

test('dataset: every gold document exists, and every required fact is verbatim in a gold document', () => {
  const norm = (s: string) => s.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  for (const i of DATASET) {
    for (const d of i.expect.goldDocs ?? [])
      assert.ok(
        CORPUS.some((c) => c.id === d),
        `${i.id}: unknown doc ${d}`,
      );
    for (const f of i.expect.facts ?? []) {
      const alts = typeof f === 'string' ? [f] : f;
      const docs = (i.expect.goldDocs ?? []).map((d) => CORPUS.find((c) => c.id === d)?.text ?? '');
      assert.ok(
        alts.some((a) => docs.some((t) => norm(t).includes(norm(a)))),
        `${i.id}: fact "${alts[0]}" is in no gold doc`,
      );
    }
  }
});

test('dataset: restricted strings really are restricted — present in a document the persona cannot see, absent from every one they can', () => {
  for (const i of DATASET) {
    const groups = PERSONAS[i.persona].groups;
    const visible = CORPUS.filter((d) => d.acl.includes('*') || d.acl.some((g) => groups.includes(g)));
    const hidden = CORPUS.filter((d) => !visible.includes(d));
    for (const r of i.expect.restricted ?? []) {
      assert.ok(
        hidden.some((d) => d.text.toLowerCase().includes(r.toLowerCase())) || r === 'CANARY',
        `${i.id}: "${r}" is in no hidden doc`,
      );
      if (r !== 'CANARY')
        assert.ok(!visible.some((d) => d.text.toLowerCase().includes(r.toLowerCase())), `${i.id}: "${r}" is visible to ${i.persona}`);
    }
  }
});

test('dataset: security has positive controls — authorized personas can reach the restricted documents', () => {
  const controls = DATASET.filter((i) => i.category === 'security' && (i.expect.goldDocs?.length ?? 0) > 0);
  assert.ok(controls.length >= 3);
});

// ------------------------------------------------------------------------------------------------ the harness works

test('the reference model passes every gate; the only failures are the known keyword-retrieval limits', async () => {
  const { results, report } = await run(new OracleModel(DATASET));
  assert.equal(report.passed, true, JSON.stringify(report.gates.filter((g) => !g.pass)));
  const failed = results.filter((r) => !r.pass);
  assert.ok(
    failed.every((r) => r.knownLimit),
    `unexpected failures: ${failed.filter((r) => !r.knownLimit).map((r) => r.id)}`,
  );
  assert.equal(report.metrics.securityFailures, 0);
  assert.match(renderMarkdown(report), /Oracle mode/);
});

// ------------------------------------------------------------------------------------------------ the harness can fail

test('a knowledge source that ignores authorization fails the security gate (so the security checks check something)', async () => {
  const { report } = await run(
    new OracleModel(DATASET),
    DATASET.filter((i) => i.category === 'security' || i.category === 'uncertainty'),
    () => new LeakyKnowledgePort(),
  );
  assert.equal(report.passed, false);
  assert.ok(report.metrics.securityFailures > 0, 'leaked canaries went unnoticed');
  assert.equal(report.gates.find((g) => g.name.startsWith('security failures'))?.pass, false);
});

test('a model that routes everything to ASK fails the routing and feedback/DO gates', async () => {
  const oracle = new OracleModel(DATASET);
  // Wrap the reference model so the routing call always answers "ask".
  const alwaysAsk: ConversationModel = {
    converse: (r) => oracle.converse(r),
    converseStructured: async <T>(r: Parameters<ConversationModel['converseStructured']>[0]) => {
      const res = await oracle.converseStructured<T>(r);
      if (res.ok && typeof res.value.output === 'object' && res.value.output !== null && 'route' in (res.value.output as object)) {
        return ok({ ...res.value, output: { ...(res.value.output as object), route: 'ask', needsClarification: false } as T });
      }
      return res;
    },
  };
  const { report } = await run(alwaysAsk);
  assert.equal(report.passed, false);
  for (const gate of ['routing pass rate', 'feedback pass rate', 'do pass rate'])
    assert.equal(report.gates.find((g) => g.name === gate)?.pass, false, gate);
});

test('a model that fails every call fails everything instead of being scored as a pass', async () => {
  const dead: ConversationModel = {
    converse: async () => err(new Error('down') as AiError),
    converseStructured: async () => err(new Error('down') as AiError),
  };
  const { results, report } = await run(dead);
  assert.ok(results.every((r) => !r.pass));
  assert.equal(report.passed, false);
});

test('a model that invents a fact or cites nothing fails the answer checks', async () => {
  const oracle = new OracleModel(DATASET);
  const sloppy: ConversationModel = {
    converse: (r) => oracle.converse(r),
    converseStructured: async <T>(r: Parameters<ConversationModel['converseStructured']>[0]) => {
      const res = await oracle.converseStructured<T>(r);
      const out = res.ok ? (res.value.output as Record<string, unknown>) : undefined;
      if (res.ok && out && 'answerable' in out) {
        return ok({ ...res.value, output: { ...out, answer: 'It is probably around INR 99 crore.', answerable: true } as T });
      }
      return res;
    },
  };
  const { report } = await run(
    sloppy,
    DATASET.filter((i) => i.category === 'ask' || i.category === 'evidence'),
  );
  assert.equal(report.passed, false);
  assert.ok((report.categories.ask.gatedPassRate ?? 1) < 0.2);
});
