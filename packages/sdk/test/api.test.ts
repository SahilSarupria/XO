import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { createXoServer } from '@xo/server';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import {
  LeaseAuthority,
  LeasedRunStore,
  LedgerReplica,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  generateReviewerKeys,
  signDecision,
} from '@xo/workflow-runtime';
import { buildGoldXo, freightClaimWorkflowIr } from '@xo/ab-eval';
import type { XoApiError } from '../src/index.js';
import { XoClient, replicateRun } from '../src/index.js';

const TOKEN = 'test-token-0123456789-abcdefghij';
const keys = generateReviewerKeys();

const component = (): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'bank',
        kind: 'http',
        operations: [
          { name: 'pay', sideEffect: 'write' },
          { name: 'note', sideEffect: 'write' },
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { claim: { type: 'string', required: true }, gated: { type: 'boolean' } },
        steps: [
          {
            id: 'pay',
            type: 'act',
            determinism: 'deterministic',
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'pay',
            sideEffect: 'write',
            idempotencyKey: 'pay:{{input.claim}}',
            inputs: { claim: { from: 'input.claim' } },
          },
          {
            id: 'note',
            type: 'act',
            determinism: 'deterministic',
            needs: ['pay'],
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'note',
            sideEffect: 'write',
            idempotencyKey: 'note:{{input.claim}}',
            inputs: { claim: { from: 'input.claim' } },
          },
        ],
        maxConcurrency: 1,
        runTimeoutMs: 600000,
        cancellation: { onCancel: 'abandon' },
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

function external(onCall?: (op: string) => Promise<void>) {
  const seen = new Set<string>();
  const effects: string[] = [];
  const op = (name: string) => ({
    sideEffect: 'write' as const,
    idempotency: 'supports_key' as const, // this fake dedupes on the key
    execute: async (_a: unknown, ctx: { idempotencyKey?: string }) => {
      await onCall?.(name);
      if (ctx.idempotencyKey !== undefined && seen.has(ctx.idempotencyKey)) return { dup: true };
      seen.add(ctx.idempotencyKey ?? name);
      effects.push(name);
      return { ok: true };
    },
  });
  const conn: Connector = { kind: 'http', operations: { pay: op('pay'), note: op('note') } };
  return { conn, effects };
}

async function boot(ext = external(), over: Record<string, unknown> = {}, comp: WorkflowComponent = component()) {
  const dir = await mkdtemp(join(tmpdir(), 'xo-api-'));
  let t = 5_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new RunStore(join(dir, 'server-runs'));
  const authority = new LeaseAuthority(join(dir, 'leases'), store, clock.now);
  const replica = new LedgerReplica(join(dir, 'forks'), store);
  const c = comp;
  const leased = new LeasedRunStore(authority, store);
  const mkRunner = (s: LeasedRunStore, owner: string, extra: object = {}) =>
    new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store: s,
      now: clock.now,
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { bank: { grant: ['pay', 'note'] } } },
        implementations: { bank: ext.conn },
        vault: new MapVault({}),
      }),
      approvals: { reviewers: new StaticReviewerRegistry([{ id: 'ann', roles: ['reviewer'], publicKeyPem: keys.publicKeyPem }]) },
      lease: {
        client: authority,
        owner,
        ttlMs: 10_000,
        heartbeatEveryMs: 0,
        attach: (id, tok) => s.attach(id, owner, tok),
        detach: (id) => s.detach(id),
      },
      ...extra,
    });
  const serverRunner = mkRunner(leased, 'server');
  const api = createXoServer({ token: TOKEN, runners: { wf: serverRunner }, store, authority, replica, now: clock.now, ...over });
  const { port } = await api.listen();
  const base = `http://127.0.0.1:${port}`;
  return { api, base, client: new XoClient({ baseUrl: base, token: TOKEN }), clock, store, authority, c, ext, dir, serverRunner };
}

const toClose: (() => Promise<void>)[] = [];
after(async () => void (await Promise.all(toClose.map((f) => f()))));

describe('HTTP API: authentication and hardening', () => {
  it('refuses unauthenticated, wrong, malformed and prefix tokens; health is the only open route', async () => {
    const b = await boot();
    toClose.push(b.api.close);
    const get = (path: string, auth?: string) => fetch(b.base + path, { headers: auth === undefined ? {} : { authorization: auth } });
    assert.equal((await get('/v1/health')).status, 200);
    for (const auth of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Bearer wrong',
      `bearer ${TOKEN}`,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
      TOKEN,
    ])
      assert.equal((await get('/v1/approvals', auth)).status, 401, String(auth));
    assert.equal((await get('/v1/approvals', `Bearer ${TOKEN}`)).status, 200);
    assert.equal((await get('/v1/approvals', 'Bearer wrong')).headers.get('access-control-allow-origin'), null, 'no CORS');
  });
  it('refuses to bind a non-loopback address without an explicit opt-in, and short tokens', async () => {
    const mk = (over: object) => () => boot(external(), over);
    await assert.rejects(mk({ host: '0.0.0.0' })(), /loopback/);
    await assert.rejects(mk({ token: 'short' })(), /24 characters/);
  });
  it('path traversal and malformed ids never reach the filesystem', async () => {
    const b = await boot();
    toClose.push(b.api.close);
    for (const p of [
      '/v1/runs/..%2f..%2fetc%2fpasswd',
      '/v1/runs/%2e%2e',
      '/v1/ledger/..%2f..',
      '/v1/runs/a%00b',
      '/v1/ledger/' + 'x'.repeat(200),
      '/v1/approvals/appr_../x',
      '/v1/workflows/..%2f/runs',
    ]) {
      const r = await fetch(b.base + p, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  });
  it('oversized bodies, wrong content types, bad JSON and wrong methods are refused', async () => {
    const b = await boot(external(), { maxBodyBytes: 1000 });
    toClose.push(b.api.close);
    const post = (body: string, ct = 'application/json') =>
      fetch(`${b.base}/v1/workflows/wf/runs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': ct }, body });
    assert.equal((await post(JSON.stringify({ inputs: { claim: 'x'.repeat(5000) } }))).status, 413);
    assert.equal((await post('{}', 'text/plain')).status, 415);
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await fetch(`${b.base}/v1/runs/run_1`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  });
  it('rate limits a noisy client', async () => {
    const b = await boot(external(), { rateLimitPerMinute: 5 });
    toClose.push(b.api.close);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(b.base + '/v1/health')).status);
    assert.ok(codes.includes(429));
  });
  it('internal errors do not leak details', async () => {
    const b = await boot();
    toClose.push(b.api.close);
    const r = await fetch(`${b.base}/v1/workflows/wf/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { claim: 5 } }),
    });
    assert.equal(r.status, 422);
    assert.ok(!JSON.stringify(await r.json()).includes('/home'));
  });
});

describe('HTTP API: runs and approvals through the SDK', () => {
  it('starts a run, deduplicates a repeated trigger, reads status', async () => {
    const b = await boot();
    toClose.push(b.api.close);
    const a = await b.client.startRun('wf', { claim: 'c1' }, 'evt-1');
    assert.equal(a.state, 'completed');
    const again = await b.client.startRun('wf', { claim: 'c1' }, 'evt-1');
    assert.equal(again.accepted, false);
    assert.equal(b.ext.effects.length, 2);
    assert.equal((await b.client.getRun(a.runId)).state, 'completed');
    await assert.rejects(b.client.getRun('run_unknown'), (e: XoApiError) => e.status === 404);
  });
  it('approval decisions over HTTP are signature-checked, bound to the request, and single-use (a replay is refused with 409)', async () => {
    const gated = component();
    const wf = gated.workflows[0] as any;
    wf.steps.splice(1, 0, {
      id: 'gate',
      type: 'approve',
      determinism: 'human',
      needs: ['pay'],
      timeoutMs: 60_000,
      roles: ['reviewer'],
      onTimeout: 'escalate',
      onError: 'escalate',
      summary: 'Confirm claim {{input.claim}}',
      inputs: { claim: { from: 'input.claim' } },
      outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
    });
    wf.steps[2].needs = ['gate'];
    wf.requiresFeatures = ['approve'];
    assert.deepEqual(
      validateWorkflowComponent(gated).issues.filter((i) => i.severity === 'error'),
      [],
    );
    const b = await boot(external(), {}, gated);
    toClose.push(b.api.close);
    const run = await b.client.startRun('wf', { claim: 'c5' });
    assert.equal(run.state, 'waiting');
    const [req] = await b.client.listApprovals();
    assert.ok(req !== undefined);
    assert.equal((await b.client.getApproval(req.approvalId)).summary, 'Confirm claim c5');
    const sign = (who: string, action: 'approve' | 'reject', key = keys.privateKeyPem) =>
      signDecision(key, {
        v: 1,
        approvalId: req.approvalId,
        runId: req.runId,
        step: req.step,
        action,
        edits: {},
        reviewerId: who,
        at: 'now',
      } as never);
    await assert.rejects(
      b.client.decideApproval(req.runId, sign('ann', 'approve', generateReviewerKeys().privateKeyPem)),
      (e: XoApiError) => e.status === 403 && e.code === 'BAD_SIGNATURE',
    );
    await assert.rejects(
      b.client.decideApproval(req.runId, sign('mallory', 'approve')),
      (e: XoApiError) => e.status === 403 && e.code === 'UNKNOWN_REVIEWER',
    );
    const good = sign('ann', 'approve');
    assert.equal((await b.client.decideApproval(req.runId, good)).state, 'completed');
    await assert.rejects(b.client.decideApproval(req.runId, good), (e: XoApiError) => e.status === 409);
    // a decision whose body names a different approval than the URL is refused before it reaches the runner
    const r = await fetch(`${b.base}/v1/approvals/${req.approvalId}/decision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId: req.runId, decision: { ...good, payload: { ...good.payload, approvalId: `appr_${'0'.repeat(64)}` } } }),
    });
    assert.equal(r.status, 400);
  });
});

describe('failover over HTTP: lease, ledger sync, fencing', () => {
  it('server takes over from the replicated ledger; the returning local runner is fenced out; the external system sees each effect once', async () => {
    let release!: () => void;
    const frozen = new Promise<void>((r) => (release = r));
    let first = true;
    const b = await boot();
    toClose.push(b.api.close);
    // an external system shared by both runners; the local runner freezes inside its "note" call
    const shared = external(async (op) => {
      if (op === 'note' && first) {
        first = false;
        await frozen;
      }
    });
    const dir = await mkdtemp(join(tmpdir(), 'xo-local-'));
    const localStore = new RunStore(dir);
    const local = new WorkflowRunner({
      component: b.c,
      workflowId: 'wf',
      store: localStore,
      now: b.clock.now,
      connectors: new ConnectorHost({
        component: b.c,
        policy: { connectors: { bank: { grant: ['pay', 'note'] } } },
        implementations: { bank: shared.conn },
        vault: new MapVault({}),
      }),
      lease: { client: b.client, owner: 'local', ttlMs: 10_000, heartbeatEveryMs: 0, attach: () => undefined, detach: () => undefined },
    });
    // rebuild the server runner against the SAME external system
    const serverStore = new LeasedRunStore(b.authority, b.store);
    const server = new WorkflowRunner({
      component: b.c,
      workflowId: 'wf',
      store: serverStore,
      now: b.clock.now,
      connectors: new ConnectorHost({
        component: b.c,
        policy: { connectors: { bank: { grant: ['pay', 'note'] } } },
        implementations: { bank: shared.conn },
        vault: new MapVault({}),
      }),
      lease: {
        client: b.authority,
        owner: 'server',
        ttlMs: 10_000,
        heartbeatEveryMs: 0,
        attach: (id, tok) => serverStore.attach(id, 'server', tok),
        detach: (id) => serverStore.detach(id),
      },
    });

    const localRun = local.start({ inputs: { claim: 'c9' }, runId: 'run_http_fo' });
    await new Promise((r) => setTimeout(r, 50));
    // local ledger so far (pay done, note in flight) is replicated under local's lease (token 1)
    const lease = await b.authority.current('run_http_fo');
    assert.equal(lease?.owner, 'local');
    const pushed = await replicateRun(b.client, localStore, 'run_http_fo', 'local', lease!.token);
    assert.equal(pushed.status, 'appended');

    // local stops heartbeating; the lease runs out; the server takes over from the replicated journal
    b.clock.advance(11_000);
    const taken = await server.resume('run_http_fo');
    assert.equal(taken.state, 'completed');

    // local wakes up; its stale token is refused at the authoritative ledger
    release();
    await localRun.catch(() => undefined);
    await assert.rejects(
      replicateRun(b.client, localStore, 'run_http_fo', 'local', lease!.token),
      (e: XoApiError) => e.code === 'LEASE_LOST' && e.status === 409,
    );
    assert.deepEqual(shared.effects.sort(), ['note', 'pay']);
    const ledger = await b.client.getLedger('run_http_fo');
    assert.equal(ledger.entries.filter((e) => e.type === 'run_finished').length, 1);
  });
  it('a second owner cannot acquire a live lease; a stale token cannot heartbeat', async () => {
    const b = await boot();
    toClose.push(b.api.close);
    const l = await b.client.acquire('run_x', 'local', 10_000);
    await assert.rejects(b.client.acquire('run_x', 'other', 10_000), (e: Error) => e.name === 'LeaseError');
    b.clock.advance(11_000);
    await b.client.acquire('run_x', 'other', 10_000);
    await assert.rejects(b.client.heartbeat('run_x', 'local', l.token, 10_000), (e: Error) => e.name === 'LeaseError');
  });
});

describe('loader resolution and receipts', () => {
  it('resolves a host against a signed bundle: level, consumed/skipped components and workflow negotiation; receipts are recorded', async () => {
    const b = await boot(external(), { bundle: buildGoldXo({ workflows: freightClaimWorkflowIr() }) });
    toClose.push(b.api.close);
    const r = await b.client.resolveLoader({ family: 'claude', capabilities: ['chat', 'tool_use'] });
    assert.equal(r.level, 'L3');
    assert.ok(r.consumed.includes('workflows'));
    const wf = r.workflows as { runnable: string[]; refused: { workflow: string }[] };
    assert.equal(
      wf.refused[0]?.workflow,
      'freight_claims',
      'needs a model for free-text extraction, so a deterministic-only host refuses it whole',
    );
    const g = await b.client.resolveLoader({ family: 'generic', capabilities: ['chat'] });
    assert.ok(g.skipped.length > 0);
    assert.equal((await b.client.receipts()).length, 2);
    await assert.rejects(b.client.resolveLoader({ family: 'claude' } as never), (e: XoApiError) => e.status === 400);
  });
});
