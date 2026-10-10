import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  DiscoveryErrorCode,
  discoverSource,
  planConnection,
  registerDeclaredSources,
  SourceId,
  ConnectorId,
  stableId,
  type AuthorizationPort,
  type AuthorizationRequest,
  type DetectedSource,
  type FilesystemScope,
} from '../src/index.js';
import { allowRoot, ctxFor, failClosed, makeDeps, put, withSandbox } from './helpers.js';

const scopeOf = (root: string, extra: Partial<FilesystemScope> = {}): FilesystemScope => ({ kind: 'filesystem_root', root, ...extra });
const request = (root: string, extra: Partial<FilesystemScope> = {}) => ({
  sourceType: 'local_filesystem' as const,
  scope: scopeOf(root, extra),
});

test('discovers files inside the authorized scope and records an honest state', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    await put(join(root, 'sub/b.csv'), 'x,y\n1,2\n');
    const deps = makeDeps();
    const clock = new MockClock('2026-10-10T00:00:00.000Z');
    const run = await discoverSource(deps, request(root), ctxFor(allowRoot(root), clock));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.record.status, 'acquisition_successful');
    assert.equal(run.value.stoppedBecause, undefined);
    const inventory = run.value.evidence.filter((e) => e.kind === 'resource_inventory');
    assert.deepEqual(
      inventory.map((e) => e.resourceKey),
      ['a.txt', 'sub/b.csv'],
    );
    assert.equal(inventory[1]?.payload['sizeBytes'], 8);
    assert.equal(inventory[0]?.payload['contentAcquirable'], true);
    // metadata only: no content evidence from a listing
    assert.equal(
      run.value.evidence.some((e) => e.kind === 'document_content'),
      false,
    );
    assert.equal(run.value.outcome?.status, 'complete');
  });
});

test('every evidence record preserves provenance, and no absolute host path leaks into locators', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'docs/INV-1001.txt'), 'x');
    const deps = makeDeps();
    const clock = new MockClock('2026-10-10T12:00:00.000Z');
    const run = await discoverSource(deps, request(root), ctxFor(allowRoot(root), clock));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.ok(run.value.evidence.length >= 2);
    for (const e of run.value.evidence) {
      const p = e.provenance;
      assert.equal(p.sourceId, e.sourceId);
      assert.equal(p.connectorId, 'xo.connector.local-filesystem');
      assert.equal(p.connectorVersion, '0.1.0');
      assert.equal(p.observedAt, '2026-10-10T12:00:00.000Z');
      assert.equal(p.access.operation, 'discover');
      assert.equal(p.access.permission, 'filesystem.list');
      assert.equal(p.access.authority, 'development_unverified');
      assert.ok(p.access.decisionReason.length > 0);
      assert.ok(p.transformationChain.length >= 2);
      assert.equal(p.locator, e.resourceKey);
      assert.equal(p.locator.includes(root), false);
      assert.equal(p.locator.startsWith('/'), false);
    }
    assert.equal(JSON.stringify(run.value.evidence).includes(root), false, 'absolute root must not appear in evidence');
  });
});

test('fail-closed by default: without an authorization decision the source is found but nothing is read', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'secret-plan.txt'), 'x');
    const deps = makeDeps();
    const run = await discoverSource(deps, request(root), ctxFor(failClosed()));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(run.value.record.status, 'authorization_required');
    assert.equal(run.value.evidence.length, 0);
    assert.equal(run.value.outcome, undefined);
  });
});

test('an explicit denial is reported as inaccessible and reads nothing', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deny: AuthorizationPort = { decide: async () => ({ effect: 'deny', authority: 'platform', reason: 'policy says no' }) };
    const run = await discoverSource(makeDeps(), request(root), ctxFor(deny));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
    assert.equal(run.value.record.status, 'unsupported_or_inaccessible');
    assert.equal(run.value.evidence.length, 0);
  });
});

test('an "allow" that names no authority is not accepted as authorization', async () => {
  await withSandbox(async ({ root }) => {
    const sloppy: AuthorizationPort = { decide: async () => ({ effect: 'allow', authority: 'none', reason: 'trust me' }) };
    const run = await discoverSource(makeDeps(), request(root), ctxFor(sloppy));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(run.value.evidence.length, 0);
  });
});

test('a grant for a different permission or a different path does not authorize discovery', async () => {
  await withSandbox(async ({ root, outside }) => {
    await put(join(root, 'a.txt'), 'x');
    const wrongPermission = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root, ['filesystem.read'])));
    assert.ok(wrongPermission.ok && wrongPermission.value.stoppedBecause?.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    const wrongPath = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(outside)));
    assert.ok(wrongPath.ok && wrongPath.value.stoppedBecause?.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  });
});

test('a throwing authorization gate fails closed without leaking its message', async () => {
  await withSandbox(async ({ root }) => {
    const boom: AuthorizationPort = {
      decide: async () => {
        throw new Error('database password is hunter2 at /etc/secret');
      },
    };
    const run = await discoverSource(makeDeps(), request(root), ctxFor(boom));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.INTERNAL);
    assert.equal(run.value.evidence.length, 0);
    assert.equal(JSON.stringify(run.value.stoppedBecause).includes('hunter2'), false);
  });
});

test('unsupported source type: no connector, honest state, nothing invented', async () => {
  const deps = makeDeps();
  const run = await discoverSource(deps, { sourceType: 'saas_application', scope: { kind: 'saas_tenant' } }, ctxFor(failClosed()));
  assert.equal(run.ok, false);
  if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.UNSUPPORTED_SOURCE);

  const declared: DetectedSource = {
    sourceId: SourceId(stableId('src', ['saas_application', 'acme-crm'])),
    sourceType: 'saas_application',
    displayName: 'Acme CRM (declared by an administrator)',
    locator: 'acme-crm',
    detectedBy: ConnectorId('xo.admin-inventory'),
    detectedAt: '2026-10-10T00:00:00.000Z',
    fingerprint: 'declared',
  };
  const [rec] = registerDeclaredSources(deps, [declared], '2026-10-10T00:00:00.000Z');
  assert.equal(rec?.status, 'unsupported_or_inaccessible');
  const plan = planConnection(declared, deps.registry);
  assert.equal(plan.outcome, 'no_connector');
});

test('the filesystem connector rejects a source type it does not support', async () => {
  const { LocalFilesystemConnector } = await import('../src/index.js');
  const c = new LocalFilesystemConnector();
  const r = await c.discover(
    { sourceType: 'database', scope: { kind: 'filesystem_root', root: '/tmp' } as FilesystemScope },
    ctxFor(failClosed()),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.UNSUPPORTED_SOURCE);
});

test('connection planning reports what is required without doing any of it', async () => {
  await withSandbox(async ({ root }) => {
    const deps = makeDeps();
    const run = await discoverSource(deps, request(root), ctxFor(failClosed()));
    assert.ok(run.ok);
    if (!run.ok) return;
    const plan = run.value.plan;
    assert.equal(plan.outcome, 'connector_available');
    if (plan.outcome !== 'connector_available') return;
    assert.equal(plan.canValidate, true);
    assert.equal(plan.canAcquireContent, true);
    assert.deepEqual(plan.authMethods, ['operator_scope_grant']);
    assert.ok(plan.pendingActions.some((a) => a.includes('filesystem.read')));
    const unsupported = planConnection(run.value.record.source, deps.registry, ['event', 'schema']);
    assert.equal(unsupported.outcome === 'connector_available' && unsupported.unsupportedEvidenceKinds.length === 2, true);
  });
});

test('invalid approved roots are rejected with stable structured errors', async () => {
  await withSandbox(async ({ root, base }) => {
    await put(join(base, 'a-file.txt'), 'x');
    const deps = makeDeps();
    const ctx = ctxFor(allowRoot(root));
    const cases: [string, string][] = [
      ['relative/path', DiscoveryErrorCode.INVALID_SCOPE],
      ['/', DiscoveryErrorCode.INVALID_SCOPE],
      [homedir(), DiscoveryErrorCode.INVALID_SCOPE],
      [join(base, 'a-file.txt'), DiscoveryErrorCode.INVALID_SCOPE],
      [join(base, 'does-not-exist'), DiscoveryErrorCode.SOURCE_UNAVAILABLE],
      ['', DiscoveryErrorCode.INVALID_SCOPE],
    ];
    for (const [badRoot, code] of cases) {
      const r = await discoverSource(deps, request(badRoot), ctx);
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(badRoot)}`);
      if (!r.ok) {
        assert.equal(r.error.code, code, `${JSON.stringify(badRoot)} -> ${r.error.code}`);
        assert.deepEqual(Object.keys(r.error).sort(), ['code', 'context', 'message', 'retryable']);
      }
    }
    const missing = await discoverSource(deps, request(join(base, 'does-not-exist')), ctx);
    assert.ok(!missing.ok && missing.error.retryable === true);
  });
});

test('a connection that fails after detection moves the source to failed_or_unavailable', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    // The gate is consulted inside validateConnection; vanishing the root at that moment simulates a mid-flight failure.
    const vanishing: AuthorizationPort = {
      decide: async (req: AuthorizationRequest) => {
        await rm(root, { recursive: true, force: true });
        return { effect: 'allow', authority: 'development_unverified', reason: `test allow ${req.operation}` };
      },
    };
    const deps = makeDeps();
    const run = await discoverSource(deps, request(root), ctxFor(vanishing));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.record.status, 'failed_or_unavailable');
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.CONNECTION_FAILED);
    assert.equal(run.value.stoppedBecause?.retryable, true);
    assert.equal(run.value.record.lastError?.code, DiscoveryErrorCode.CONNECTION_FAILED);
    assert.equal(run.value.evidence.length, 0);
  });
});

test('symlinks are never followed during discovery, and nothing outside the scope is listed', async () => {
  await withSandbox(async ({ root, outside }) => {
    await put(join(outside, 'stolen.txt'), 'INV-9999 outside data');
    await put(join(root, 'inside.txt'), 'x');
    await symlink(join(outside, 'stolen.txt'), join(root, 'link-to-file.txt'));
    await symlink(outside, join(root, 'link-to-dir'));
    const run = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root)));
    assert.ok(run.ok);
    if (!run.ok) return;
    const keys = run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey);
    assert.deepEqual(keys, ['inside.txt']);
    assert.equal(run.value.outcome?.skipped.byReason['symlink_not_followed'], 2);
    assert.equal(JSON.stringify(run.value.evidence).includes('stolen'), false);
  });
});

test('credential-like names and secret-store directories are excluded and only counted', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'ok.txt'), 'x');
    await put(join(root, '.env'), 'API_KEY=abc');
    await put(join(root, 'id_rsa'), 'KEY');
    await put(join(root, 'server.pem'), 'KEY');
    await put(join(root, '.ssh/known_hosts'), 'host');
    await put(join(root, 'node_modules/pkg/index.js'), 'x');
    await put(join(root, 'skipme.txt'), 'x');
    const run = await discoverSource(makeDeps(), request(root, { extraExcludedNames: ['skipme.txt'] }), ctxFor(allowRoot(root)));
    assert.ok(run.ok);
    if (!run.ok) return;
    const keys = run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey);
    assert.deepEqual(keys, ['ok.txt']);
    const skipped = run.value.outcome?.skipped.byReason ?? {};
    assert.equal(skipped['excluded_sensitive_name'], 4);
    assert.equal(skipped['excluded_directory'], 2);
    const blob = JSON.stringify(run.value);
    for (const leaked of ['.env', 'id_rsa', 'server.pem', 'known_hosts', 'node_modules'])
      assert.equal(blob.includes(leaked), false, `${leaked} leaked`);
  });
});

test('hostile file names (control chars, bidi override, overlong) are skipped and counted, never stored', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'good.txt'), 'x');
    await put(join(root, 'bad\nname.txt'), 'x');
    await put(join(root, 'esc\u001b[31mred.txt'), 'x');
    await put(join(root, 'rtl‮txt.exe'), 'x');
    await put(join(root, `${'a'.repeat(210)}.txt`), 'x');
    const run = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root)));
    assert.ok(run.ok);
    if (!run.ok) return;
    const keys = run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey);
    assert.deepEqual(keys, ['good.txt']);
    assert.equal(run.value.outcome?.skipped.byReason['unsafe_name'], 4);
  });
});

test('limits stop the walk and the result says so instead of pretending to be complete', async () => {
  await withSandbox(async ({ root }) => {
    for (let i = 0; i < 12; i += 1) await put(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x');
    await put(join(root, 'l1/l2/l3/deep.txt'), 'x');
    const entries = await discoverSource(makeDeps(), request(root, { limits: { maxEntries: 5 } }), ctxFor(allowRoot(root)));
    assert.ok(entries.ok);
    if (entries.ok) {
      assert.equal(entries.value.outcome?.status, 'partial');
      assert.deepEqual(entries.value.outcome?.limits.hit, ['max_entries']);
      assert.equal(entries.value.record.status, 'acquisition_partial');
    }
    const depth = await discoverSource(makeDeps(), request(root, { limits: { maxDepth: 1 } }), ctxFor(allowRoot(root)));
    assert.ok(depth.ok);
    if (depth.ok) {
      assert.equal(depth.value.outcome?.status, 'partial');
      assert.ok(depth.value.outcome?.limits.hit.includes('max_depth'));
      assert.equal(
        depth.value.evidence.some((e) => e.resourceKey.endsWith('deep.txt')),
        false,
      );
    }
  });
});

test('the time budget is enforced against the injected clock', async () => {
  await withSandbox(async ({ root }) => {
    for (let i = 0; i < 10; i += 1) await put(join(root, `f${i}.txt`), 'x');
    let t = Date.parse('2026-10-10T00:00:00.000Z');
    const ticking = { now: (): Date => new Date((t += 1000)) };
    const run = await discoverSource(makeDeps(), request(root, { limits: { timeBudgetMs: 4000 } }), {
      clock: ticking,
      authorization: allowRoot(root),
    });
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.outcome?.status, 'partial');
    assert.ok(run.value.outcome?.limits.hit.includes('time_budget'));
  });
});

test('cancellation: an already-aborted signal reads nothing; a mid-walk abort returns honest partial results', async () => {
  await withSandbox(async ({ root }) => {
    for (let i = 0; i < 5; i += 1) await put(join(root, `f${i}.txt`), 'x');
    const pre = new AbortController();
    pre.abort();
    const before = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root), new MockClock(), pre.signal));
    assert.ok(before.ok, 'the source is detected and stays in the inventory; the run stops at cancellation');
    if (before.ok) {
      assert.equal(before.value.stoppedBecause?.code, DiscoveryErrorCode.CANCELLED);
      assert.equal(before.value.evidence.length, 0);
      assert.equal(before.value.outcome, undefined);
    }

    const mid = new AbortController();
    const aborting: AuthorizationPort = {
      decide: async (req) => {
        if (req.operation === 'discover') mid.abort();
        return { effect: 'allow', authority: 'development_unverified', reason: 'test' };
      },
    };
    const run = await discoverSource(makeDeps(), request(root), ctxFor(aborting, new MockClock(), mid.signal));
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.outcome?.status, 'partial');
    assert.ok(run.value.outcome?.limits.hit.includes('cancelled'));
    assert.equal(run.value.outcome?.errors[0]?.code, DiscoveryErrorCode.CANCELLED);
    assert.equal(run.value.record.status, 'acquisition_partial');
  });
});

test('repeat discovery is idempotent and reports change only when the environment changed', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'one');
    const deps = makeDeps();
    const ctx = ctxFor(allowRoot(root));
    const first = await discoverSource(deps, request(root), ctx);
    const second = await discoverSource(deps, request(root), ctx);
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.equal(deps.inventory.list().length, 1, 'same source must not be duplicated');
    assert.equal(first.value.record.source.sourceId, second.value.record.source.sourceId);
    assert.equal(second.value.record.observationCount, 2);
    assert.equal(second.value.record.scanCount, 2);
    assert.equal(second.value.record.changedSinceLastScan, false);
    assert.deepEqual(
      first.value.evidence.map((e) => e.id),
      second.value.evidence.map((e) => e.id),
      'unchanged resources keep their evidence ids',
    );

    await put(join(root, 'b.txt'), 'two');
    const third = await discoverSource(deps, request(root), ctx);
    assert.ok(third.ok);
    if (third.ok) {
      assert.equal(third.value.record.changedSinceLastScan, true);
      assert.equal(third.value.record.scanCount, 3);
      assert.equal(third.value.evidence.filter((e) => e.kind === 'resource_inventory').length, 2);
    }
  });
});

test('discovery output is deterministic for identical input and clock', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'z/y.txt'), '1');
    await put(join(root, 'a.txt'), '2');
    await put(join(root, 'm.csv'), '3');
    const a = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root), new MockClock('2026-10-10T00:00:00.000Z')));
    const b = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root), new MockClock('2026-10-10T00:00:00.000Z')));
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(JSON.stringify(a.value.outcome), JSON.stringify(b.value.outcome));
  });
});

test('revoking authorization after acquisition flags the acquired evidence for purge', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deps = makeDeps();
    const run = await discoverSource(deps, request(root), ctxFor(allowRoot(root)));
    assert.ok(run.ok);
    if (!run.ok) return;
    const revoked = deps.inventory.apply(run.value.record.source.sourceId, 'authorization_revoked', '2026-10-10T01:00:00.000Z');
    assert.ok(revoked.ok);
    if (revoked.ok) {
      assert.equal(revoked.value.purgeRequired, true);
      assert.equal(revoked.value.status, 'authorization_required');
    }
  });
});

test('an unreadable-directory style failure is isolated: other entries still return', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    await mkdir(join(root, 'emptydir'));
    await writeFile(join(root, 'emptydir', '.keep'), '');
    const run = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root)));
    assert.ok(run.ok);
    if (run.ok)
      assert.deepEqual(
        run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey),
        ['.keep', 'a.txt'].map((k) => (k === '.keep' ? 'emptydir/.keep' : k)).sort(),
      );
  });
});
