/**
 * M2.2 - audit semantics and the fail-closed evidence lifecycle.
 *
 * Ordering is proven with an ACTUAL trace: a recording `fsOps` seam and a scripted recorder append to one shared
 * event list, so "the attempt was accepted before any protected read" is a comparison of positions in that list, not
 * an inference. Every failure test is paired with a healthy control under the same setup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  ConnectorRegistry,
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  acquireSourceContent,
  auditError,
  buildEnvironmentModel,
  discoverSource,
  normalizeAuditRecordRequest,
  purgeSourceEvidence,
  revokeSourceEvidence,
  selectEligibleEvidence,
  type AuditError,
  type AuditReceipt,
  type AuditRecordRequest,
  type AuditRecorder,
  type AuditTrust,
  type ConnectorContext,
  type DiscoveryDeps,
  type Evidence,
  type EvidenceId,
  type FilesystemScope,
  type SourceId,
} from '../src/index.js';
import * as pkg from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { TEST_PRINCIPAL, allowRoot, authenticated, ctxFor, failClosed, put, withSandbox } from './helpers.js';

const LIST = 'filesystem.list';
const READ = 'filesystem.read';
const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const request = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Behavior = 'ok' | 'reject' | 'throw' | 'hang' | 'garbage' | 'wrong_receipt' | `delay:${number}`;

/** Wraps a real in-memory recorder and misbehaves on demand, logging every step to a shared trace. */
class ScriptedRecorder implements AuditRecorder {
  readonly inner = new InMemoryAuditRecorder();
  readonly calls: AuditRecordRequest[] = [];
  constructor(
    private readonly trace: string[],
    private readonly script: (req: AuditRecordRequest, n: number) => Behavior = () => 'ok',
    private readonly onAccepted?: (req: AuditRecordRequest) => void,
  ) {}

  async record(req: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    this.calls.push(req);
    const n = this.calls.filter((c) => c.idempotencyKey === req.idempotencyKey).length;
    const tag = `${req.phase}:${req.outcome}`;
    this.trace.push(`audit:start:${tag}`);
    const behavior = this.script(req, n);
    if (behavior === 'reject') return err(auditError(AuditErrorCode.UNAVAILABLE, 'disk full /secret/path'));
    if (behavior === 'throw') throw new Error('boom at /secret/path');
    if (behavior === 'hang') return new Promise<never>(() => undefined);
    if (behavior === 'garbage') return undefined as unknown as Result<AuditReceipt, AuditError>;
    if (behavior.startsWith('delay:')) await sleep(Number(behavior.slice(6)));
    const stored = await this.inner.record(req, trust);
    if (!stored.ok) return stored;
    if (behavior === 'wrong_receipt') return ok({ ...stored.value, idempotencyKey: 'someone-else:attempt' });
    this.trace.push(`audit:accepted:${tag}`);
    this.onAccepted?.(req);
    return stored;
  }
}

function tracingOps(trace: string[]): FsOps {
  return {
    ...NODE_FS_OPS,
    open: (p, f) => {
      trace.push('fs:open');
      return NODE_FS_OPS.open(p, f);
    },
    readdirLimited: (p, limit) => {
      if (limit > 0) trace.push('fs:list');
      return NODE_FS_OPS.readdirLimited(p, limit);
    },
    readText: (p) => {
      trace.push('fs:readText');
      return NODE_FS_OPS.readText(p);
    },
  };
}

const READS = new Set(['fs:open', 'fs:list', 'fs:readText']);
const readsIn = (trace: readonly string[]): number => trace.filter((e) => READS.has(e)).length;

function depsWith(trace: string[]): DiscoveryDeps {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector({ fsOps: tracingOps(trace) }));
  return { registry, inventory: new EnvironmentInventory() };
}

interface Harness {
  readonly trace: string[];
  readonly recorder: ScriptedRecorder;
  readonly ledger: EvidenceLedger;
  readonly deps: DiscoveryDeps;
  ctx(extra?: Partial<ConnectorContext>): ConnectorContext;
}

function harness(
  base: string,
  script?: (req: AuditRecordRequest, n: number) => Behavior,
  onAccepted?: (req: AuditRecordRequest) => void,
  permissions: readonly string[] = [LIST, READ],
): Harness {
  const trace: string[] = [];
  const recorder = new ScriptedRecorder(trace, script, onAccepted);
  const ledger = new EvidenceLedger();
  const deps = depsWith(trace);
  const clock = new MockClock();
  return {
    trace,
    recorder,
    ledger,
    deps,
    ctx: (extra = {}) => ({
      ...ctxFor(allowRoot(base, permissions), clock),
      audit: recorder,
      ledger,
      auditOptions: { acceptTimeoutMs: 40, attempts: 2 },
      ...extra,
    }),
  };
}

const acquireReq = (sourceId: SourceId, root: string, keys: readonly string[] = ['a.txt']) => ({
  sourceId,
  kind: 'document_content' as const,
  resourceKeys: keys,
  scope: scopeOf(root),
});

/** Discovers `root` (so the source is authorized + validated) and returns its id. Healthy recorder only. */
async function discovered(h: Harness, root: string): Promise<SourceId> {
  const run = await discoverSource(h.deps, request(root), h.ctx());
  assert.ok(run.ok, 'setup: discovery must succeed');
  return (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
}

const outcomes = (h: Harness, operation?: string): string[] =>
  h.recorder.inner
    .events()
    .filter((e) => operation === undefined || e.operation === operation)
    .map((e) => `${e.phase}:${e.outcome}`);

// ---------------------------------------------------------------------------------------------------------------------
// 1-2. Write-ahead
// ---------------------------------------------------------------------------------------------------------------------

test('the attempt is accepted BEFORE any protected read (acquisition and discovery), proven on a shared trace', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const h = harness(base);
    const sourceId = await discovered(h, root);

    // Discovery: the first read-type call comes after the discover attempt was accepted.
    const discoverAccepted = h.trace.indexOf('audit:accepted:attempt:attempted');
    const firstRead = h.trace.findIndex((e) => READS.has(e));
    assert.ok(discoverAccepted >= 0 && firstRead > discoverAccepted, `discover: ${h.trace.join(' | ')}`);

    h.trace.length = 0;
    const acq = await acquireSourceContent(h.deps, acquireReq(sourceId, root), h.ctx());
    assert.ok(acq.ok && acq.value.evidence.length === 1, 'the acquisition itself succeeds');
    const accepted = h.trace.indexOf('audit:accepted:attempt:attempted');
    const read = h.trace.findIndex((e) => READS.has(e));
    assert.ok(accepted >= 0, 'an attempt was accepted');
    assert.ok(read > accepted, `acquire: first read (${read}) is after the accepted attempt (${accepted}): ${h.trace.join(' | ')}`);
    assert.ok(h.trace.indexOf('audit:accepted:terminal:completed') > read, 'and the completion is accepted after the work');
  });
});

const ATTEMPT_FAILURES: ReadonlyArray<readonly [string, Behavior]> = [
  ['rejects', 'reject'],
  ['throws', 'throw'],
  ['never answers (timeout)', 'hang'],
  ['returns garbage', 'garbage'],
  ['returns a receipt for a different event', 'wrong_receipt'],
];

test('attempt-audit failure prevents the protected read, whatever form the failure takes', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const setup = harness(base);
    const sourceId = await discovered(setup, root);

    for (const [name, behavior] of ATTEMPT_FAILURES) {
      const h = harness(base, (req) => (req.phase === 'attempt' ? behavior : 'ok'));
      // Reuse the setup harness's validated inventory for this source; only the recorder differs.
      const sameDeps = setup.deps;
      const ctx = { ...h.ctx(), audit: h.recorder, ledger: h.ledger };
      h.trace.length = 0;
      const r = await acquireSourceContent(sameDeps, acquireReq(sourceId, root), ctx);
      assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE, `${name}: refused`);
      assert.equal(readsIn(h.trace), 0, `${name}: no protected read happened`);
      assert.ok(!JSON.stringify(r).includes('/secret/path'), `${name}: recorder message not leaked`);
      assert.equal(h.ledger.counts().released, 0, `${name}: nothing released`);
    }
    // The same discovery path is also write-ahead.
    for (const [name, behavior] of ATTEMPT_FAILURES) {
      const h = harness(base, (req) => (req.phase === 'attempt' ? behavior : 'ok'));
      const r = await discoverSource(h.deps, request(root), h.ctx());
      assert.ok(
        r.ok && r.value.stoppedBecause?.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE,
        `discover/${name}: stopped at the audit gate`,
      );
      assert.equal(readsIn(h.trace), 0, `discover/${name}: no protected read`);
      assert.equal(r.ok ? r.value.evidence.length : -1, 0, `discover/${name}: no evidence`);
    }
    // Control: a healthy recorder under the very same setup reads and releases.
    const control = await acquireSourceContent(setup.deps, acquireReq(sourceId, root), setup.ctx());
    assert.ok(control.ok && control.value.evidence.length === 1);
  });
});

test('no recorder configured: protected evidence operations are refused (there is no no-op default)', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base);
    const sourceId = await discovered(h, root);
    const noAudit: ConnectorContext = { ...h.ctx() };
    delete (noAudit as { audit?: unknown }).audit;
    h.trace.length = 0;
    const acq = await acquireSourceContent(h.deps, acquireReq(sourceId, root), noAudit);
    assert.ok(!acq.ok && acq.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    const disc = await discoverSource(depsWith(h.trace), request(root), noAudit);
    assert.ok(disc.ok && disc.value.stoppedBecause?.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE && disc.value.evidence.length === 0);
    assert.equal(readsIn(h.trace), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3-5. Completion, quarantine, no false success
// ---------------------------------------------------------------------------------------------------------------------

test('a completion record follows the operation and describes it: outcome, counts and opaque evidence ids', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const h = harness(base);
    const sourceId = await discovered(h, root);
    const acq = await acquireSourceContent(h.deps, acquireReq(sourceId, root), h.ctx());
    assert.ok(acq.ok);
    const events = h.recorder.inner.events().filter((e) => e.operation === 'acquire_content');
    assert.deepEqual(
      events.map((e) => `${e.phase}:${e.outcome}`),
      ['attempt:attempted', 'terminal:completed'],
    );
    const [attempt, terminal] = events;
    assert.equal(attempt?.operationId, terminal?.operationId);
    assert.equal(terminal?.counts?.evidence, 1);
    assert.deepEqual(terminal?.evidenceIds, acq.ok ? acq.value.evidence.map((e) => e.id).sort() : []);
    assert.equal(terminal?.partial, false);
    assert.equal(attempt?.principal.id, TEST_PRINCIPAL.id);
    assert.equal(attempt?.decision?.effect, 'allow');
    assert.equal(attempt?.decision?.authority, 'development_unverified');
    assert.ok(attempt?.requestedScope?.ref.startsWith('scp_') && attempt.grantedScope?.ref.startsWith('scp_'));
    assert.deepEqual(h.recorder.inner.openAttempts(), [], 'no attempt is left without a terminal event');
    assert.equal(h.ledger.counts().released > 0, true, 'released evidence is tracked as eligible');
  });
});

test('completion-audit failure quarantines the acquired evidence and releases nothing', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042 confidential');
    const setup = harness(base);
    const sourceId = await discovered(setup, root);
    for (const [name, behavior] of [
      ['rejects', 'reject'],
      ['throws', 'throw'],
      ['hangs', 'hang'],
      ['garbage', 'garbage'],
      ['wrong receipt', 'wrong_receipt'],
    ] as const) {
      const h = harness(base, (req) => (req.phase === 'terminal' ? behavior : 'ok'));
      const r = await acquireSourceContent(setup.deps, acquireReq(sourceId, root), { ...h.ctx(), audit: h.recorder, ledger: h.ledger });
      assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED, `${name}: quarantined, not released`);
      if (!r.ok) {
        assert.equal(r.error.context['evidenceCount'], 1, name);
        const text = JSON.stringify(r.error);
        assert.ok(!text.includes('INV-1042') && !text.includes('sha256:'), `${name}: the error carries no evidence content`);
      }
      assert.equal(h.ledger.counts().quarantined, 1, `${name}: ledger shows the quarantine`);
      assert.equal(h.ledger.counts().released, 0, `${name}: nothing was released`);
    }
    // The audit trail is honest: attempted, then quarantined (when the recorder could still take it) - never `completed`.
    const h2 = harness(base, (req) => (req.outcome === 'completed' ? 'reject' : 'ok'));
    const r2 = await acquireSourceContent(setup.deps, acquireReq(sourceId, root), { ...h2.ctx(), audit: h2.recorder, ledger: h2.ledger });
    assert.ok(!r2.ok && r2.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED && r2.error.context['quarantineAudited'] === true);
    assert.deepEqual(outcomes(h2), ['attempt:attempted', 'terminal:quarantined']);
    // Control: a transient failure that clears on retry (same idempotency key) is NOT a quarantine.
    const h3 = harness(base, (req, n) => (req.phase === 'terminal' && n === 1 ? 'reject' : 'ok'));
    const r3 = await acquireSourceContent(setup.deps, acquireReq(sourceId, root), { ...h3.ctx(), audit: h3.recorder, ledger: h3.ledger });
    assert.ok(r3.ok && r3.value.evidence.length === 1, 'a retried completion that is accepted releases normally');
    assert.deepEqual(outcomes(h3), ['attempt:attempted', 'terminal:completed'], 'and exactly one terminal event exists');
  });
});

test('no false success: a result with a missing completion audit is never reported as completed', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    // Discovery: completion refused -> the discovery's evidence is not released.
    const h = harness(base, (req) => (req.operation === 'discover' && req.phase === 'terminal' ? 'reject' : 'ok'));
    const run = await discoverSource(h.deps, request(root), h.ctx());
    assert.ok(run.ok);
    if (run.ok) {
      assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.EVIDENCE_QUARANTINED);
      assert.equal(run.value.evidence.length, 0, 'no evidence reached the caller');
      assert.equal(run.value.outcome, undefined);
    }
    // An empty (zero-evidence) successful result is also not "success" without its completion record.
    await mkdir(join(base, 'empty'), { recursive: true });
    const h2 = harness(base, (req) => (req.phase === 'terminal' ? 'reject' : 'ok'));
    const connector = new LocalFilesystemConnector();
    const r = await connector.discover(request(join(base, 'empty')), h2.ctx());
    assert.ok(!r.ok, 'success with no accepted completion is an error, not a result');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Denials
// ---------------------------------------------------------------------------------------------------------------------

test('authorization denial is audited without exposing protected content; unauthenticated callers are not', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'secret-name.txt'), 'INV-1042 token=sk-live-ABC123');
    const trace: string[] = [];
    const recorder = new ScriptedRecorder(trace);
    const ctx: ConnectorContext = { ...ctxFor(failClosed()), audit: recorder };
    const r = await discoverSource(depsWith(trace), request(root), ctx);
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    const events = recorder.inner.events();
    assert.equal(events.length, 1);
    assert.deepEqual(
      [events[0]?.phase, events[0]?.outcome, events[0]?.decision?.effect, events[0]?.decision?.authority],
      ['standalone', 'denied', 'prompt', 'none'],
    );
    assert.equal(events[0]?.principal.id, TEST_PRINCIPAL.id);
    const text = JSON.stringify(events);
    for (const secret of [root, base, 'secret-name', 'INV-1042', 'sk-live'])
      assert.ok(!text.includes(secret), `denial record excludes ${secret}`);
    assert.equal(readsIn(trace), 0);

    const anon = new ScriptedRecorder(trace);
    const r2 = await discoverSource(depsWith(trace), request(root), { ...ctx, audit: anon, principal: undefined } as ConnectorContext);
    assert.ok(!r2.ok && r2.error.code === DiscoveryErrorCode.UNAUTHENTICATED);
    assert.equal(anon.calls.length, 0, 'an unauthenticated caller cannot write to the audit trail');
    // Control: a denial whose audit write fails is still a denial (it never turns into an allow).
    const broken = new ScriptedRecorder(trace, () => 'reject');
    const r3 = await discoverSource(depsWith(trace), request(root), { ...ctx, audit: broken });
    assert.ok(!r3.ok && r3.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Failure and cancellation
// ---------------------------------------------------------------------------------------------------------------------

test('an operation that fails after the attempt is recorded as failed, with its error code', async () => {
  await withSandbox(async ({ base, root }) => {
    const outside = join(base, 'outside');
    await put(join(outside, 'b.txt'), 'x');
    await put(join(root, 'a.txt'), 'x');
    await symlink(outside, join(root, 'link'));
    const h = harness(base);
    const sourceId = await discovered(h, root);
    const r = await acquireSourceContent(h.deps, acquireReq(sourceId, root, ['link/b.txt']), h.ctx());
    assert.ok(!r.ok, 'the escape is refused');
    const terminal = h.recorder.inner.events().filter((e) => e.operation === 'acquire_content' && e.phase === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.outcome, 'failed');
    assert.equal(terminal[0]?.errorCode, r.ok ? undefined : r.error.code);
    assert.equal(h.ledger.counts().quarantined, 0);
  });
});

test('cancellation after the attempt is recorded as cancelled, and the completion write is not blocked by the abort', async () => {
  await withSandbox(async ({ base, root }) => {
    for (let i = 0; i < 5; i += 1) await put(join(root, `f${i}.txt`), `INV-${i}`);
    const setup = harness(base);
    const sourceId = await discovered(setup, root);
    const controller = new AbortController();
    const h = harness(base, undefined, (req) => {
      if (req.phase === 'attempt' && req.operation === 'acquire_content') controller.abort();
    });
    const r = await acquireSourceContent(setup.deps, acquireReq(sourceId, root, ['f0.txt', 'f1.txt']), {
      ...h.ctx({ signal: controller.signal }),
      audit: h.recorder,
      ledger: h.ledger,
    });
    const events = h.recorder.inner.events();
    assert.deepEqual(
      events.map((e) => `${e.phase}:${e.outcome}`),
      ['attempt:attempted', 'terminal:cancelled'],
      'the cancellation itself was audited',
    );
    assert.equal(events[1]?.errorCode, DiscoveryErrorCode.CANCELLED);
    assert.ok(!r.ok || r.value.evidence.length === 0, 'nothing was read after the abort');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. Revocation and purge
// ---------------------------------------------------------------------------------------------------------------------

const allowLifecycle = (): PolicyRule[] =>
  ['data.write', 'data.delete'].map((p) => ({
    id: `allow-${p}`,
    effect: 'ALLOW' as const,
    match: { permission: PermissionId(p), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
  }));

function lifecycleCtx(h: Harness, rules: readonly PolicyRule[] = allowLifecycle()): ConnectorContext {
  const clock = new MockClock();
  const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: new InMemoryAuditSink(), clock });
  return {
    clock,
    authorization: new PermissionManagerAuthorization(manager),
    principal: TEST_PRINCIPAL,
    audit: h.recorder,
    auditOptions: { acceptTimeoutMs: 40, attempts: 2 },
  };
}

async function releasedEvidence(h: Harness, root: string, key = 'a.txt'): Promise<{ sourceId: SourceId; evidence: Evidence[] }> {
  const run = await discoverSource(h.deps, request(root), h.ctx());
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  const acq = await acquireSourceContent(h.deps, acquireReq(sourceId, root, [key]), h.ctx());
  assert.ok(acq.ok);
  const evidence = [...(run.ok ? run.value.evidence : []), ...(acq.ok ? acq.value.evidence : [])];
  return { sourceId, evidence };
}

test('revoked and purged evidence is no longer eligible for model input or evidence selection, and the audit trail keeps growing', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    await put(join(root, 'b.txt'), 'INV-1042');
    const h = harness(base);
    const { sourceId, evidence } = await releasedEvidence(h, root);
    const build = () =>
      buildEnvironmentModel({
        origin: 'test_fixture',
        generatedAt: '2026-10-12T00:00:00.000Z',
        inventory: h.deps.inventory,
        evidence,
        eligibility: h.ledger,
      });
    assert.ok(selectEligibleEvidence(h.ledger, evidence).length === evidence.length, 'positive control: all released evidence is eligible');
    assert.equal(build().evidenceCount, evidence.length);
    const before = h.recorder.inner.events().length;

    const rev = await revokeSourceEvidence({ inventory: h.deps.inventory, ledger: h.ledger }, { sourceId }, lifecycleCtx(h));
    assert.ok(rev.ok, 'revocation succeeds and reports an audit receipt');
    assert.equal(rev.ok ? rev.value.outcome : undefined, 'revoked');
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, 0, 'revoked evidence cannot be selected');
    const model = build();
    assert.equal(model.evidenceCount, 0, 'nor feed the model');
    assert.ok(
      model.notices.some((n) => n.includes('excluded')),
      'and the model says it excluded evidence',
    );
    assert.equal(h.deps.inventory.get(sourceId)?.purgeRequired, true, 'the existing purge flag is set');

    const purged: EvidenceId[][] = [];
    const pur = await purgeSourceEvidence(
      { inventory: h.deps.inventory, ledger: h.ledger },
      { sourceId, targets: [{ purge: async (ids) => void purged.push([...ids]) }] },
      lifecycleCtx(h),
    );
    assert.ok(pur.ok && pur.value.outcome === 'purged', 'purge succeeds');
    assert.equal(purged.length, 1, 'the holder was asked to delete');
    assert.equal(h.deps.inventory.get(sourceId)?.purgeRequired, false);
    assert.ok(evidence.every((e) => h.ledger.stateOf(e.id) === 'purged'));
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, 0);

    const events = h.recorder.inner.events();
    assert.ok(events.length > before, 'audit history grew');
    assert.ok(
      events.some((e) => e.outcome === 'completed'),
      'the original completion evidence of the access is still present',
    );
    const purgeTerminal = events.find((e) => e.operation === 'purge_evidence' && e.phase === 'terminal');
    assert.equal(purgeTerminal?.outcome, 'purged');
    assert.ok((purgeTerminal?.evidenceIds ?? []).length > 0, 'the purge receipt names what was purged (opaque ids)');
    // Re-authorized, audited re-acquisition is a NEW release and is eligible again (documented semantics).
    const refused = await acquireSourceContent(h.deps, acquireReq(sourceId, root), h.ctx());
    assert.ok(!refused.ok, 'a revoked source cannot be read again without being re-authorized');
    const rediscovered = await discoverSource(h.deps, request(root), h.ctx());
    assert.ok(rediscovered.ok && rediscovered.value.outcome !== undefined, 're-authorized discovery');
    const again = await acquireSourceContent(h.deps, acquireReq(sourceId, root), h.ctx());
    assert.ok(again.ok && again.value.evidence.every((e) => h.ledger.isEligible(e.id)), 'a fresh audited release is eligible again');
  });
});

test('never-released evidence is not eligible: eligibility is granted by an audited release, not assumed', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base);
    const { evidence } = await releasedEvidence(h, root);
    const stranger = new EvidenceLedger();
    assert.equal(selectEligibleEvidence(stranger, evidence).length, 0);
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, evidence.length);
  });
});

test('revoke/purge are protected: authenticated, authorized, write-ahead audited, and fail safe', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base);
    const { sourceId, evidence } = await releasedEvidence(h, root);
    const deps = { inventory: h.deps.inventory, ledger: h.ledger };

    const anon = await revokeSourceEvidence(deps, { sourceId }, { ...lifecycleCtx(h), principal: undefined } as ConnectorContext);
    assert.ok(!anon.ok && anon.error.code === DiscoveryErrorCode.UNAUTHENTICATED);
    const noRule = await purgeSourceEvidence(deps, { sourceId }, lifecycleCtx(h, []));
    assert.ok(!noRule.ok && noRule.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, 'no policy: denied');
    assert.ok(
      h.recorder.inner.events().some((e) => e.outcome === 'denied' && e.operation === 'purge_evidence'),
      'the denial is audited',
    );
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, evidence.length, 'a refused revoke/purge changed nothing');

    // Attempt not accepted -> nothing changes.
    const broken = new ScriptedRecorder(h.trace, (req) => (req.phase === 'attempt' ? 'reject' : 'ok'));
    const blocked = await revokeSourceEvidence(deps, { sourceId }, { ...lifecycleCtx(h), audit: broken });
    assert.ok(!blocked.ok && blocked.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.equal(h.deps.inventory.get(sourceId)?.axes.authorization, 'granted', 'the source is still authorized');
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, evidence.length);

    // Completion not accepted -> the (safe-direction) change is applied but NOT reported as audited; a retry reconciles.
    const flaky = new ScriptedRecorder(h.trace, (req) => (req.phase === 'terminal' ? 'reject' : 'ok'));
    const unaudited = await revokeSourceEvidence(deps, { sourceId, operationId: 'op_retry_1' }, { ...lifecycleCtx(h), audit: flaky });
    assert.ok(!unaudited.ok && unaudited.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    if (!unaudited.ok) assert.deepEqual([unaudited.error.context['applied'], unaudited.error.context['completionAudited']], [true, false]);
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, 0, 'the evidence is already ineligible');
    const retry = await revokeSourceEvidence(deps, { sourceId, operationId: 'op_retry_1' }, lifecycleCtx(h));
    assert.ok(retry.ok, 'retrying with the same operationId completes the audit');
    const terminals = h.recorder.inner.events().filter((e) => e.operationId === 'op_retry_1' && e.phase === 'terminal');
    assert.equal(terminals.length, 1, 'exactly one terminal event for the operation');
  });
});

test('a purge whose holder fails is audited as failed and the evidence stays ineligible', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base);
    const { sourceId, evidence } = await releasedEvidence(h, root);
    const r = await purgeSourceEvidence(
      { inventory: h.deps.inventory, ledger: h.ledger },
      {
        sourceId,
        targets: [
          {
            purge: async () => {
              throw new Error('holder offline at /secret/path');
            },
          },
        ],
      },
      lifecycleCtx(h),
    );
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.INTERNAL);
    assert.ok(!JSON.stringify(r).includes('/secret/path'));
    assert.ok(
      evidence.every((e) => h.ledger.stateOf(e.id) === 'revoked'),
      'revoked (ineligible), not purged',
    );
    assert.equal(selectEligibleEvidence(h.ledger, evidence).length, 0);
    const terminal = h.recorder.inner.events().filter((e) => e.operation === 'purge_evidence' && e.phase === 'terminal');
    assert.deepEqual(
      terminal.map((e) => e.outcome),
      ['failed'],
    );
    assert.equal(h.deps.inventory.get(sourceId)?.purgeRequired, true, 'purge still required');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. Data minimization
// ---------------------------------------------------------------------------------------------------------------------

test('audit records exclude raw content, credentials, tokens, host paths and file names', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'payroll-2026.txt'), 'INV-1042 password=hunter2 api_key=sk-live-ABC123 token=ghp_SECRET');
    const h = harness(base);
    const { sourceId } = await releasedEvidence(h, root, 'payroll-2026.txt');
    await acquireSourceContent(h.deps, acquireReq(sourceId, root, ['payroll-2026.txt']), h.ctx());
    const text = JSON.stringify(h.recorder.inner.events());
    for (const needle of [root, base, 'payroll', 'hunter2', 'sk-live', 'ghp_SECRET', 'INV-1042', '.txt', '/']) {
      // A single '/' check would be too blunt for timestamps, which contain none; ids/refs must contain none either.
      assert.ok(!text.includes(needle), `record must not contain ${JSON.stringify(needle)}`);
    }
  });
});

test('the closed schema rejects anything that could carry content: unknown fields, paths, free text, wrong shapes', () => {
  const good: AuditRecordRequest = {
    idempotencyKey: 'op_1:attempt',
    operationId: 'op_1',
    phase: 'attempt',
    outcome: 'attempted',
    operation: 'discover',
    occurredAt: '2026-10-12T00:00:00.000Z',
    principal: { kind: 'human', id: 'operator-1' },
    connectorId: 'xo.local-filesystem',
    permission: 'filesystem.list',
  };
  assert.ok(normalizeAuditRecordRequest(good).ok, 'positive control');
  const attacks: ReadonlyArray<readonly [string, unknown]> = [
    ['unknown field: content', { ...good, content: 'INV-1042 password=hunter2' }],
    ['unknown field: token', { ...good, token: 'ghp_x' }],
    ['unknown field: path', { ...good, path: '/etc/passwd' }],
    ['path as sourceId', { ...good, sourceId: '/home/user/docs' }],
    ['space-bearing free text as connectorId', { ...good, connectorId: 'connector with free text' }],
    ['path in principal id', { ...good, principal: { kind: 'human', id: '../../etc/passwd' } }],
    ['extra principal field', { ...good, principal: { kind: 'human', id: 'x', roles: ['admin'] } }],
    ['path as scope ref', { ...good, requestedScope: { kind: 'path', ref: '/srv/data' } }],
    ['scope with a path field', { ...good, requestedScope: { kind: 'path', ref: 'scp_1', path: '/srv/data' } }],
    ['free-text error code', { ...good, errorCode: 'failed to read /srv/data/secret.txt' }],
    ['non-hash keys digest', { ...good, keysDigest: 'a.txt,b.txt' }],
    ['evidence ids carrying a path', { ...good, evidenceIds: ['/srv/a.txt'] }],
    ['outcome not allowed in the phase', { ...good, outcome: 'completed' }],
    ['key not derived from operation + phase', { ...good, idempotencyKey: 'other:attempt' }],
    ['bad timestamp', { ...good, occurredAt: 'yesterday' }],
    ['overlong id', { ...good, operationId: 'x'.repeat(300), idempotencyKey: `${'x'.repeat(300)}:attempt` }],
    ['not an object', 'string'],
  ];
  for (const [name, input] of attacks) {
    const r = normalizeAuditRecordRequest(input);
    assert.ok(!r.ok && r.error.code === AuditErrorCode.INVALID_EVENT, name);
  }
});

test('a platform policy id outside the log-safe alphabet is recorded as a digest, never as written', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base);
    const rule: PolicyRule = {
      id: 'team/payroll-allow-1',
      effect: 'ALLOW',
      match: { permission: PermissionId(LIST), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
    };
    const manager = new PermissionManager({
      policy: new RuleBasedPolicy([rule]),
      auditSink: new InMemoryAuditSink(),
      clock: new MockClock(),
    });
    const run = await discoverSource(h.deps, request(root), { ...h.ctx(), authorization: new PermissionManagerAuthorization(manager) });
    assert.ok(run.ok && run.value.outcome !== undefined);
    const attempt = h.recorder.inner.events().find((e) => e.phase === 'attempt');
    assert.ok(attempt?.decision?.policyId?.startsWith('h_'), 'digest, not the written id');
    assert.equal(attempt?.decision?.authority, 'platform');
    assert.ok(!JSON.stringify(attempt).includes('payroll'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. Asynchronous correctness
// ---------------------------------------------------------------------------------------------------------------------

test('async: a slow attempt delays the read; it never races ahead of acceptance', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base, (req) => (req.phase === 'attempt' ? 'delay:25' : 'ok'));
    const ctx = h.ctx({ auditOptions: { acceptTimeoutMs: 500, attempts: 1 } });
    const run = await discoverSource(h.deps, request(root), ctx);
    assert.ok(run.ok && run.value.outcome !== undefined);
    const accepted = h.trace.indexOf('audit:accepted:attempt:attempted');
    const firstRead = h.trace.findIndex((e) => READS.has(e));
    assert.ok(accepted >= 0 && firstRead > accepted, h.trace.join(' | '));
  });
});

test('async: the result is not returned until the completion is accepted', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const h = harness(base, (req) => (req.phase === 'terminal' ? 'delay:30' : 'ok'));
    const ctx = h.ctx({ auditOptions: { acceptTimeoutMs: 500, attempts: 1 } });
    const started = Date.now();
    const run = await discoverSource(h.deps, request(root), ctx);
    h.trace.push('result:returned');
    assert.ok(run.ok && run.value.outcome !== undefined);
    assert.ok(Date.now() - started >= 28, 'the caller waited for the completion write');
    assert.ok(h.trace.indexOf('audit:accepted:terminal:completed') < h.trace.indexOf('result:returned'), h.trace.join(' | '));
  });
});

test('async: a completion that lands AFTER the timeout cannot release the evidence', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const setup = harness(base);
    const sourceId = await discovered(setup, root);
    const h = harness(base, (req, n) => (req.outcome === 'completed' && n === 1 ? 'delay:120' : 'ok'));
    const ctx = { ...h.ctx({ auditOptions: { acceptTimeoutMs: 30, attempts: 1 } }), audit: h.recorder, ledger: h.ledger };
    const r = await acquireSourceContent(setup.deps, acquireReq(sourceId, root), ctx);
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED, 'timed out -> quarantined');
    await sleep(200); // the late write lands now
    assert.equal(h.ledger.counts().released, 0, 'late acceptance did not release anything');
    assert.equal(h.ledger.counts().quarantined, 1);
    assert.deepEqual(
      outcomes(h),
      ['attempt:attempted', 'terminal:quarantined'],
      'the contradictory late `completed` was refused by the recorder',
    );
  });
});

test('async: concurrent operations do not cross-release: one failing completion quarantines only its own evidence', async () => {
  await withSandbox(async ({ base, root }) => {
    const two = join(base, 'approved-two');
    await put(join(root, 'a.txt'), 'one');
    await put(join(two, 'b.txt'), 'two');
    const setup = harness(base);
    const idA = await discovered(setup, root);
    const idB = await discovered(setup, two);
    const h = harness(base, (req) => (req.phase === 'terminal' && req.sourceId === idA ? 'reject' : 'ok'));
    const ctx = { ...h.ctx(), audit: h.recorder, ledger: h.ledger };
    const [a, b] = await Promise.all([
      acquireSourceContent(setup.deps, acquireReq(idA, root), ctx),
      acquireSourceContent(setup.deps, acquireReq(idB, two, ['b.txt']), ctx),
    ]);
    assert.ok(!a.ok && a.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED);
    assert.ok(b.ok && b.value.evidence.length === 1);
    assert.deepEqual([h.ledger.counts().released, h.ledger.counts().quarantined], [1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Recorder semantics (shared by every backend) and public surface
// ---------------------------------------------------------------------------------------------------------------------

test('recorder semantics: idempotent retry, conflict, and ordering', async () => {
  const rec0 = new InMemoryAuditRecorder();
  const trust: AuditTrust = { principal: authenticated('operator-1') };
  const rec = {
    record: (e: AuditRecordRequest) => rec0.record(e, trust),
    events: () => rec0.events(),
    openAttempts: () => rec0.openAttempts(),
  };
  const attempt: AuditRecordRequest = {
    idempotencyKey: 'op_9:attempt',
    operationId: 'op_9',
    phase: 'attempt',
    outcome: 'attempted',
    operation: 'acquire_content',
    occurredAt: '2026-10-12T00:00:00.000Z',
    principal: { kind: 'human', id: 'operator-1' },
    connectorId: 'xo.local-filesystem',
    permission: 'filesystem.read',
  };
  const terminal: AuditRecordRequest = { ...attempt, idempotencyKey: 'op_9:terminal', phase: 'terminal', outcome: 'completed' };

  const orphan = await rec.record(terminal);
  assert.ok(!orphan.ok && orphan.error.code === AuditErrorCode.ORDER_VIOLATION, 'a terminal event needs an accepted attempt');
  const first = await rec.record(attempt);
  assert.ok(first.ok && !first.value.duplicate);
  const retry = await rec.record({ ...attempt, occurredAt: '2026-10-12T00:00:09.000Z' });
  assert.ok(
    retry.ok && retry.value.duplicate && retry.value.eventId === (first.ok ? first.value.eventId : ''),
    'an exact retry returns the original receipt',
  );
  const contradict = await rec.record({ ...attempt, permission: 'filesystem.list' });
  assert.ok(!contradict.ok && contradict.error.code === AuditErrorCode.CONFLICT, 'same key, different content');
  assert.equal(rec.events().length, 1, 'neither the retry nor the contradiction wrote anything');
  assert.deepEqual(rec.openAttempts(), ['op_9']);
  assert.ok((await rec.record(terminal)).ok);
  const second = await rec.record({ ...terminal, idempotencyKey: 'op_9:standalone', phase: 'standalone', outcome: 'denied' });
  assert.ok(second.ok, 'a standalone event is not an operation terminal');
  const twoTerminals = await rec.record({ ...terminal, outcome: 'failed' });
  assert.ok(
    !twoTerminals.ok && twoTerminals.error.code === AuditErrorCode.CONFLICT,
    'a different terminal outcome under the same key is a conflict',
  );
  const lateAttempt = await rec.record({ ...attempt, operationId: 'op_9', idempotencyKey: 'op_9:attempt', permission: 'filesystem.read' });
  assert.ok(lateAttempt.ok && lateAttempt.value.duplicate);
  assert.deepEqual(rec.openAttempts(), []);
});

test('audit internals are not part of the public surface; the documented types and test recorder are', () => {
  const surface = pkg as unknown as Record<string, unknown>;
  for (const name of ['beginAudit', 'AuditSession', 'auditDenial', 'acceptAuditEvent', 'runAudited']) {
    assert.equal(surface[name], undefined, `${name} must stay internal`);
  }
  for (const name of [
    'InMemoryAuditRecorder',
    'normalizeAuditRecordRequest',
    'EvidenceLedger',
    'revokeSourceEvidence',
    'purgeSourceEvidence',
    'AuditErrorCode',
  ]) {
    assert.notEqual(surface[name], undefined, `${name} is public`);
  }
});
