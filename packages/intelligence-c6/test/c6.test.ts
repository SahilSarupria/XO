/**
 * The adapter against the REAL C6 stack: real C4 ingestion, real C5 derivation, real C6 SDK, real per-resource
 * authorization decisions and audit — using the EI package's own test environment (imported from its test/support, so
 * this test is coupled to that harness; if it moves, update the import). Nothing here uses a real model or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
// Imported from EI's SOURCE, like its test harness: mixing the built package with the harness's source would load two copies
// of the trusted-decision module, and C6 (correctly) refuses decisions minted by a different copy.
import { createKnowledgeSdk, type KnowledgeSdk } from '../../environment-intelligence/src/index.js';
import { IntelligenceOrchestrator, UnconfiguredKnowledgePort, type Principal } from '@xo/intelligence';
import { C6KnowledgePort, c6KnowledgeFactory } from '../src/index.js';
import { withSandbox } from '../../environment-intelligence/test/helpers.js';
import { OrgProvider, authenticated, knowledgeEnv, type KnowledgeEnv } from '../../environment-intelligence/test/support/knowledge-env.js';
import { HR, PATHS, loadAll, seedOrg } from '../../environment-intelligence/test/support/org-fixtures.js';

type Cred = ReturnType<typeof authenticated>;

async function boot(base: string): Promise<{ env: KnowledgeEnv; sdk: KnowledgeSdk }> {
  const env = await knowledgeEnv(base, { provider: seedOrg(new OrgProvider()), paths: PATHS });
  await loadAll(env);
  const { principal: _p, signal: _s, ...platform } = env.ctx;
  return { env, sdk: createKnowledgeSdk({ model: env.model, platform }) };
}
/** What the API builds: the platform credential rides on Principal.authenticated, identityId matches it. */
const as = (cred: Cred, role = 'viewer'): Principal => ({ identityId: cred.id, workspaceId: 'ws_1', role, authenticated: cred });
const port = (sdk: KnowledgeSdk) => new C6KnowledgePort({ sdk });
const ask = (p: C6KnowledgePort, who: Principal, query: string, limit = 12) => p.retrieve({ principal: who, query, limit });

test('a known fact comes back as evidence with its provenance, tagged keyword-only', async () => {
  await withSandbox(async ({ base }) => {
    const { env, sdk } = await boot(base);
    const r = await ask(port(sdk), as(authenticated('admin-1')), 'Who owns the Atlas project?');
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.method, 'lexical', 'C6 free-text query is lexical by its own contract; the chat must say so');
    const owns = r.evidence.find((e) => /priya sharma owns PRJ-ATLAS/i.test(e.excerpt));
    assert.ok(owns, JSON.stringify(r.evidence.map((e) => e.excerpt)));
    assert.equal(owns.sourceType, 'c6:relationship');
    assert.match(owns.id, /\S/);
    assert.ok(owns.asOf !== undefined && !Number.isNaN(Date.parse(owns.asOf)));
    assert.match(owns.excerpt, /\((single source|\d+ sources)\)$/, 'how many sources back a statement is part of what the model reads');
    assert.doesNotMatch(owns.excerpt, /^(CONFLICTED|HYPOTHESIS|UNKNOWN)/);
    await env.store.close();
  });
});

test('a conflict between sources is delivered AS a conflict, with both values, never smoothed into one fact', async () => {
  await withSandbox(async ({ base }) => {
    const { env, sdk } = await boot(base);
    const r = await ask(port(sdk), as(authenticated('admin-1')), 'approval limit');
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    const c = r.evidence.find((e) => e.sourceType === 'c6:conflict');
    assert.ok(c, JSON.stringify(r.evidence.map((e) => e.excerpt)));
    assert.match(c.excerpt, /^CONFLICTED — the sources disagree and a person must decide: /);
    assert.ok(c.excerpt.includes('300000') && c.excerpt.includes('500000'));
    await env.store.close();
  });
});

test("authorization is C6's: a principal denied a source gets nothing derived from it, and access changes apply on the next call", async () => {
  await withSandbox(async ({ base }) => {
    const { env, sdk } = await boot(base);
    const p = port(sdk);
    const hr = env.sourceOf(HR) as string;
    env.policy.hide = (who, source) => who === 'contractor-1' && source === hr;
    const q = 'priya title finance manager';
    const admin = await ask(p, as(authenticated('admin-1')), q);
    const contractor = await ask(p, as(authenticated('contractor-1')), q);
    assert.ok(admin.status === 'ok' && contractor.status === 'ok');
    if (admin.status !== 'ok' || contractor.status !== 'ok') return;
    const text = (evidence: readonly { excerpt: string }[]) => evidence.map((e) => e.excerpt).join('\n');
    assert.match(text(admin.evidence), /finance manager/i, 'the authorized principal does see the HR-derived title');
    // The contractor may still see Priya from OTHER sources; what must never reach them is anything derived from HR.
    assert.doesNotMatch(text(contractor.evidence), /finance manager|E100/i, 'no HR-derived value reaches the contractor');
    assert.doesNotMatch(JSON.stringify(contractor), new RegExp(hr), 'not even the hidden source id');
    env.policy.hide = () => false;
    const after = await ask(p, as(authenticated('contractor-1')), q);
    assert.ok(after.status === 'ok' && /finance manager/i.test(text(after.evidence)), 'access changes apply on the very next call');
    await env.store.close();
  });
});

test('C6 refusals are honest and distinct: denied is not "not found", and an outage is not an empty result', async () => {
  await withSandbox(async ({ base }) => {
    const { env, sdk } = await boot(base);
    const p = port(sdk);
    const admin = as(authenticated('admin-1'));
    env.policy.query = false;
    assert.deepEqual(await ask(p, admin, 'priya'), { status: 'unavailable', reason: 'denied' });
    env.policy.query = true;
    env.policy.outage = true;
    assert.deepEqual(await ask(p, admin, 'priya'), { status: 'unavailable', reason: 'error' });
    env.policy.outage = false;
    env.recorder.refuse = (e) => e.operation === 'query_knowledge' && e.phase === 'terminal';
    assert.deepEqual(
      await ask(p, admin, 'priya'),
      { status: 'unavailable', reason: 'error' },
      'no data when the read could not be audited',
    );
    env.recorder.refuse = undefined;
    assert.equal((await ask(p, admin, 'priya')).status, 'ok');
    await env.store.close();
  });
});

test("no genuine credential, or one that is not the caller's, means C6 is never called", async () => {
  let calls = 0;
  const spy: Pick<KnowledgeSdk, 'query'> = {
    query: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  };
  const p = new C6KnowledgePort({ sdk: spy });
  const cred = authenticated('admin-1');
  const forged = { kind: 'human', id: 'admin-1' } as unknown;
  for (const who of [
    { identityId: 'admin-1', workspaceId: 'w', role: 'admin' },
    { identityId: 'admin-1', workspaceId: 'w', role: 'admin', authenticated: forged },
    { identityId: 'someone-else', workspaceId: 'w', role: 'admin', authenticated: cred },
  ])
    assert.deepEqual(await p.retrieve({ principal: who, query: 'priya', limit: 5 }), { status: 'unavailable', reason: 'denied' });
  assert.equal(calls, 0);
});

test('a workspace with no C6 environment is "not configured" — it does not fall back to another source', async () => {
  const f = c6KnowledgeFactory({ sdkFor: () => undefined });
  assert.ok(f({ workspaceId: 'ws_x' }) instanceof UnconfiguredKnowledgePort);
  const g = c6KnowledgeFactory({
    sdkFor: () => ({
      query: async () => {
        throw new Error('x');
      },
    }),
  });
  assert.ok(g({ workspaceId: 'ws_x' }) instanceof C6KnowledgePort);
});

test('END TO END: orchestrator + C6 — a cited answer, the conflict shown, and the keyword-only caveat disclosed', async () => {
  await withSandbox(async ({ base }) => {
    const { env, sdk } = await boot(base);
    const provider = new ScriptableTestProvider('p', [
      {
        kind: 'success',
        response: jsonResponse(
          {
            route: 'ask',
            confidence: 0.95,
            reasoning: 'x',
            standaloneQuery: 'approval limit',
            needsClarification: false,
            clarifyingQuestion: '',
          },
          { inputTokens: 1, outputTokens: 1 },
          'm',
        ),
      },
      {
        kind: 'success',
        response: jsonResponse(
          {
            answerable: true,
            answer: 'The approval limit is recorded as 300000 in one source and 500000 in another [E1].',
            confidence: 'high',
            confidenceReason: 'x',
            contradictions: [{ summary: 'Two different approval limits.', evidenceIds: ['E1'] }],
            gaps: [],
            followUps: [],
          },
          { inputTokens: 1, outputTokens: 1 },
          'm',
        ),
      },
    ]);
    const model = new ConversationLayer({
      providers: [provider],
      policy: { rules: [{ capability: '*', providerOrder: ['p'], modelByProvider: { p: 'm' } }] },
      retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
    });
    const o = new IntelligenceOrchestrator({ model, knowledge: port(sdk) });
    const r = await o.handle({ principal: as(authenticated('admin-1')), message: 'What is the approval limit?' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.grounded, true);
    assert.equal(r.value.confidence, 'medium', 'a conflict caps confidence');
    assert.ok(r.value.notices.some((n) => n.code === 'contradiction_detected'));
    assert.ok(r.value.notices.some((n) => n.code === 'keyword_search_only'));
    assert.match(provider.callLog[1]!.messages.at(-1)!.content, /CONFLICTED — the sources disagree/);
    assert.equal(r.value.citations[0]?.sourceType, 'c6:conflict');
    await env.store.close();
  });
});
