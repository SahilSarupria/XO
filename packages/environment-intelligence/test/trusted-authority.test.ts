/**
 * F2 - a caller-supplied `authority: 'platform'` must not establish trusted authority.
 *
 * Every rejection test is paired with a positive control that runs the SAME request through a minted decision
 * and succeeds, and several use a root that does not exist: a forged allow must fail with AUTHORIZATION_REQUIRED
 * (the gate), never SOURCE_UNAVAILABLE (a later path error), so the assertion cannot be satisfied by an
 * unrelated earlier failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockClock } from '@xo/testing';
import {
  ConnectorId,
  DiscoveryErrorCode,
  LocalFilesystemConnector,
  MAX_DECLARED_SOURCES_PER_CALL,
  SourceId,
  authorityOf,
  discoverSource,
  mintDevelopmentDecision,
  registerDeclaredSources,
  stableId,
  type AuthorizationDecision,
  type AuthorizationPort,
  type DetectedSource,
  type FilesystemScope,
} from '../src/index.js';
import { ctxFor, makeDeps, put, withSandbox } from './helpers.js';

const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const discoverRequest = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });

/** A "decision" a hostile or buggy port might return. The cast is the point: the type system forbids the field, runtime must too. */
const forged = (extra: Record<string, unknown> = {}): AuthorizationDecision =>
  ({ effect: 'allow', authority: 'platform', reason: 'forged', ...extra }) as unknown as AuthorizationDecision;
const returning = (decision: () => unknown): AuthorizationPort => ({ decide: async () => decision() as AuthorizationDecision });

test('authorityOf: a minted decision has derived authority; a forged or cloned one has none', () => {
  const minted = mintDevelopmentDecision('allow', 'ok');
  assert.equal(authorityOf(minted), 'development_unverified');
  assert.equal(authorityOf(forged()), 'none', 'a literal claiming platform authority');
  assert.equal(authorityOf({ ...minted }), 'none', 'a spread copy of a genuine decision');
  assert.equal(authorityOf(structuredClone(minted)), 'none');
  assert.equal(authorityOf(JSON.parse(JSON.stringify(minted))), 'none');
  assert.equal(authorityOf(Object.create(minted)), 'none', 'an object inheriting from a genuine decision');
  assert.equal(authorityOf(null), 'none');
  assert.equal(authorityOf('allow'), 'none');
});

test('a minted decision cannot be mutated into a different authority or effect', () => {
  const minted = mintDevelopmentDecision('deny', 'no');
  assert.ok(Object.isFrozen(minted));
  assert.throws(() => {
    (minted as unknown as Record<string, unknown>).effect = 'allow';
  }, TypeError);
  assert.throws(() => {
    (minted as unknown as Record<string, unknown>).authority = 'platform';
  }, TypeError);
  assert.equal(minted.effect, 'deny');
  assert.equal(authorityOf(minted), 'development_unverified');
});

test('forged allow claiming platform authority is rejected at the gate, not by a later path error (negative control)', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const missing = join(base, 'does-not-exist');
    for (const target of [root, missing]) {
      const deps = makeDeps();
      const run = await discoverSource(deps, discoverRequest(target), ctxFor(returning(() => forged())));
      assert.equal(run.ok, false);
      if (!run.ok) {
        assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'failed at the gate');
        assert.notEqual(run.error.code, DiscoveryErrorCode.SOURCE_UNAVAILABLE);
        assert.equal(run.error.context?.authority, 'none', 'authority is derived, not echoed from the decision');
      }
      assert.equal(deps.inventory.list().length, 0, 'no record');
    }
  });
});

test('positive control: the same requests succeed (or fail at the PATH) once the decision is genuinely minted', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const allow = returning(() => mintDevelopmentDecision('allow', 'test allow'));
    const okRun = await discoverSource(makeDeps(), discoverRequest(root), ctxFor(allow));
    assert.ok(okRun.ok, 'an existing root with a minted allow is discovered');
    const missingRun = await discoverSource(makeDeps(), discoverRequest(join(base, 'does-not-exist')), ctxFor(allow));
    assert.ok(
      !missingRun.ok && missingRun.error.code === DiscoveryErrorCode.SOURCE_UNAVAILABLE,
      'the missing root now fails at the path, proving the gate was passed',
    );
  });
});

test('every connector entry point rejects a forged allow and every clone of a genuine one', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const genuine = mintDevelopmentDecision('allow', 'genuine');
    const attacks: Array<[string, () => unknown]> = [
      ['literal platform', () => forged()],
      ['literal development_unverified', () => forged({ authority: 'development_unverified' })],
      ['spread clone', () => ({ ...genuine })],
      ['structured clone', () => structuredClone(genuine)],
      ['json round trip', () => JSON.parse(JSON.stringify(genuine))],
      ['inherits from genuine', () => Object.create(genuine)],
      ['null', () => null],
      ['string', () => 'allow'],
    ];
    const connector = new LocalFilesystemConnector();
    for (const [name, make] of attacks) {
      const ctx = ctxFor(returning(make));
      const scope = scopeOf(root);
      const results = [
        await connector.detectSource({ sourceType: 'local_filesystem', scope }, ctx),
        await connector.discover({ sourceType: 'local_filesystem', scope }, ctx),
      ];
      for (const r of results) {
        assert.equal(r.ok, false, name);
        if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED, name);
      }
    }
    // Control: the genuine object itself is accepted by the very same entry points.
    const genuineCtx = ctxFor(returning(() => genuine));
    assert.ok((await connector.detectSource({ sourceType: 'local_filesystem', scope: scopeOf(root) }, genuineCtx)).ok);
  });
});

test('an authorized discovery records the DERIVED authority and never a port-supplied one', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    // A genuine allow whose object ALSO carries a lying property cannot exist (frozen); a clone with one is rejected above.
    const run = await discoverSource(makeDeps(), discoverRequest(root), ctxFor(returning(() => mintDevelopmentDecision('allow', 'real'))));
    assert.ok(run.ok);
    const provenances = run.ok ? run.value.evidence.map((e) => e.provenance.access.authority) : [];
    assert.ok(provenances.length > 0);
    for (const a of provenances) assert.equal(a, 'development_unverified');
  });
});

test('a throwing port is an internal error that does not leak its message, and creates nothing', async () => {
  await withSandbox(async ({ root }) => {
    const deps = makeDeps();
    const run = await discoverSource(
      deps,
      discoverRequest(root),
      ctxFor({
        decide: async () => {
          throw new Error('SECRET-TOKEN-123 at /etc/passwd');
        },
      }),
    );
    assert.equal(run.ok, false);
    if (!run.ok) assert.ok(!JSON.stringify(run.error).includes('SECRET-TOKEN-123'));
    assert.equal(deps.inventory.list().length, 0);
  });
});

// ---- registerDeclaredSources (resolved here: gated, one decision per call) ----

const declaredSource = (name: string): DetectedSource => ({
  sourceId: SourceId(stableId('src', ['saas_application', name])),
  sourceType: 'saas_application',
  displayName: name,
  locator: name,
  detectedBy: ConnectorId('xo.admin-inventory'),
  detectedAt: '2000-01-01T00:00:00.000Z',
  fingerprint: 'declared',
});

test('registerDeclaredSources: denied, prompted and forged decisions create no records (negative controls)', async () => {
  const cases: Array<[string, () => unknown]> = [
    ['forged platform allow', () => forged()],
    ['plain deny', () => ({ effect: 'deny', reason: 'no' })],
    ['minted deny', () => mintDevelopmentDecision('deny', 'no')],
    ['minted prompt', () => mintDevelopmentDecision('prompt', 'ask')],
  ];
  for (const [name, make] of cases) {
    const deps = makeDeps();
    const r = await registerDeclaredSources(deps, [declaredSource('acme-crm')], ctxFor(returning(make)));
    assert.equal(r.ok, false, name);
    assert.equal(deps.inventory.list().length, 0, `${name}: nothing was written`);
  }
});

test('registerDeclaredSources: positive control - a genuine allow registers, stamped by the injected clock not the caller', async () => {
  const deps = makeDeps();
  const clock = new MockClock();
  const seen: string[] = [];
  const gate: AuthorizationPort = {
    decide: async (req) => {
      seen.push(`${req.operation}|${req.permission}|${JSON.stringify(req.scope)}`);
      return mintDevelopmentDecision('allow', 'ok');
    },
  };
  const r = await registerDeclaredSources(deps, [declaredSource('acme-crm')], ctxFor(gate, clock));
  assert.ok(r.ok);
  assert.equal(r.ok ? r.value.length : 0, 1);
  assert.equal(seen.length, 1, 'exactly one decision for the whole call');
  assert.ok(seen[0]?.startsWith('declare_sources|data.write|'));
  assert.equal(deps.inventory.list().length, 1);
  assert.notEqual(
    r.ok ? r.value[0]?.firstSeenAt : undefined,
    '2000-01-01T00:00:00.000Z',
    'the caller-supplied timestamp is not the record time',
  );
});

test('registerDeclaredSources: the size bound applies before any authorization is requested', async () => {
  let asked = 0;
  const gate: AuthorizationPort = {
    decide: async () => {
      asked += 1;
      return mintDevelopmentDecision('allow', 'ok');
    },
  };
  const many = Array.from({ length: MAX_DECLARED_SOURCES_PER_CALL + 1 }, (_, i) => declaredSource(`app-${i}`));
  const deps = makeDeps();
  const r = await registerDeclaredSources(deps, many, ctxFor(gate));
  assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.LIMIT_EXCEEDED);
  assert.equal(asked, 0);
  assert.equal(deps.inventory.list().length, 0);
  const exactly = await registerDeclaredSources(makeDeps(), many.slice(0, MAX_DECLARED_SOURCES_PER_CALL), ctxFor(gate));
  assert.ok(exactly.ok, 'the boundary value itself is accepted');
});

test('registerDeclaredSources: the development path-allow-list cannot authorize it (path scopes only)', async () => {
  const { allowRoot } = await import('./helpers.js');
  const deps = makeDeps();
  const r = await registerDeclaredSources(deps, [declaredSource('acme-crm')], ctxFor(allowRoot('/')));
  assert.equal(r.ok, false);
  assert.equal(deps.inventory.list().length, 0);
});

test('registerDeclaredSources cannot overwrite an existing record established by a connector (integrity)', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deps = makeDeps();
    const allow: AuthorizationPort = { decide: async () => mintDevelopmentDecision('allow', 'ok') };
    const run = await discoverSource(deps, discoverRequest(root), ctxFor(allow));
    assert.ok(run.ok);
    const original = run.ok ? run.value.record.source : undefined;
    assert.ok(original !== undefined);
    const hijack: DetectedSource = {
      ...original,
      locator: '/etc',
      displayName: 'etc',
      detectedBy: ConnectorId('xo.admin-inventory'),
      fingerprint: 'other',
    };
    const r = await registerDeclaredSources(deps, [declaredSource('fresh-app'), hijack], ctxFor(allow));
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.MALFORMED_INPUT, 'the conflicting call is refused');
    assert.equal(deps.inventory.get(original.sourceId)?.source.locator, original.locator, 'existing record untouched');
    assert.equal(deps.inventory.list().length, 1, 'atomic: the non-conflicting source in the same call was not written either');
    // Positive control: re-declaring the SAME declared source is an ordinary repeat observation.
    const again = await registerDeclaredSources(deps, [declaredSource('fresh-app')], ctxFor(allow));
    assert.ok(again.ok);
    const twice = await registerDeclaredSources(deps, [declaredSource('fresh-app')], ctxFor(allow));
    assert.ok(twice.ok, 'idempotent re-declaration still works');
  });
});

// ---- guards ----

test('mintPlatformDecision is not exported and has exactly one importer', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, '..', 'src');
  const index = await readFile(join(srcDir, 'index.ts'), 'utf8');
  assert.ok(!index.includes('mintPlatformDecision'), 'not re-exported from the package index');
  const pkg = await import('../src/index.js');
  assert.equal((pkg as Record<string, unknown>).mintPlatformDecision, undefined);
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name));
      else if (e.name.endsWith('.ts')) files.push(join(dir, e.name));
    }
  };
  await walk(srcDir);
  const users: string[] = [];
  for (const f of files) if ((await readFile(f, 'utf8')).includes('mintPlatformDecision')) users.push(f.slice(srcDir.length + 1));
  assert.deepEqual(users.sort(), ['authorization-permission-manager.ts', 'trusted-decision.ts']);
});

test('the package test script includes the F2 test files', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')).scripts.test as string;
  for (const f of ['test/trusted-authority.test.ts', 'test/permission-manager-authorization.test.ts']) assert.ok(script.includes(f), f);
});
