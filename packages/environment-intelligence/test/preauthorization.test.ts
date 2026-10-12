/**
 * F12 — authorization precedes filesystem probing and inventory records.
 *
 * Scope: `LocalFilesystemConnector` entry points (detect, validate, discover, acquire) and the
 * `discoverSource` orchestration. Forged-authority (F2) and `registerDeclaredSources` gating are covered in
 * `trusted-authority.test.ts`; denial auditing (M2.2 audit port / P1.0 M4) is not implemented here.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readFile, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DevelopmentOperatorAuthorization,
  DiscoveryErrorCode,
  LocalFilesystemConnector,
  SourceId,
  discoverSource,
  type AuthorizationPort,
  type AuthorizationRequest,
  type FilesystemScope,
} from '../src/index.js';
import { allowRoot, ctxFor, failClosed, makeDeps, put, withSandbox } from './helpers.js';

interface FsCall {
  readonly fn: string;
  readonly path: string;
}

/** Records filesystem calls on the watched paths. Calls pass through to the real implementation. */
function installFsSpy(): { calls: FsCall[]; watch(paths: readonly string[]): void; restore(): void } {
  const calls: FsCall[] = [];
  let prefixes: readonly string[] = [];
  const names = ['realpath', 'lstat', 'stat', 'readdir', 'open', 'access', 'opendir', 'readFile'] as const;
  for (const name of names) {
    const target = fsp as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = target[name] as (...args: unknown[]) => unknown;
    mock.method(target, name, function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      if (typeof first === 'string' && prefixes.some((p) => first === p || first.startsWith(`${p}/`)))
        calls.push({ fn: name, path: first });
      return original.apply(this, args);
    });
  }
  syncBuiltinESMExports();
  return {
    calls,
    watch(paths) {
      prefixes = paths;
      calls.length = 0;
    },
    restore() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

const scopeOf = (root: string, extra: Record<string, unknown> = {}): FilesystemScope =>
  ({ kind: 'filesystem_root', root, ...extra }) as FilesystemScope;

type AnyResult = { ok: boolean; error?: { code: string; message: string; context: unknown } };

const connector = new LocalFilesystemConnector();
const entryPoints: readonly [string, (scope: FilesystemScope, ctx: ReturnType<typeof ctxFor>) => Promise<AnyResult>][] = [
  ['detectSource', (scope, ctx) => connector.detectSource({ sourceType: 'local_filesystem', scope }, ctx) as Promise<AnyResult>],
  [
    'validateConnection',
    (scope, ctx) => connector.validateConnection({ sourceType: 'local_filesystem', scope }, ctx) as Promise<AnyResult>,
  ],
  ['discover', (scope, ctx) => connector.discover({ sourceType: 'local_filesystem', scope }, ctx) as Promise<AnyResult>],
  [
    'acquireContent',
    (scope, ctx) =>
      connector.acquireContent(
        { sourceId: SourceId('src-unauthorized-probe'), kind: 'document_content', resourceKeys: ['a.txt'], scope },
        ctx,
      ) as Promise<AnyResult>,
  ],
];

const denialGates: readonly [string, () => AuthorizationPort][] = [
  ['fail-closed default', () => failClosed()],
  ['explicit deny', () => ({ decide: async () => ({ effect: 'deny', reason: 'no' }) })],
  ['prompt', () => ({ decide: async () => ({ effect: 'prompt', reason: 'ask a human' }) })],
  ['allow naming no authority', () => ({ decide: async () => ({ effect: 'allow', reason: 'trust me' }) })],
];

test('every filesystem entry point authorizes BEFORE touching the requested path, and denials do not reveal existence or type', async () => {
  await withSandbox(async ({ root, base }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    await put(join(base, 'a-file.txt'), 'x');
    const existingDir = root;
    const aFile = join(base, 'a-file.txt');
    const missing = join(base, 'does-not-exist');
    const spy = installFsSpy();
    try {
      for (const [entryName, run] of entryPoints) {
        for (const [gateName, makeGate] of denialGates) {
          const seen: string[] = [];
          for (const [label, path] of [
            ['existing directory', existingDir],
            ['regular file', aFile],
            ['nonexistent path', missing],
          ] as const) {
            spy.watch([existingDir, aFile, missing]);
            const r = await run(scopeOf(path), ctxFor(makeGate()));
            assert.equal(r.ok, false, `${entryName}/${gateName}/${label}`);
            assert.equal(
              spy.calls.length,
              0,
              `${entryName}/${gateName}/${label}: no filesystem call on the requested path before authorization (saw ${JSON.stringify(spy.calls)})`,
            );
            seen.push(JSON.stringify(r.error));
            assert.equal(JSON.stringify(r.error).includes(path), false, 'the requested path must not be echoed');
          }
          assert.equal(new Set(seen).size, 1, `${entryName}/${gateName}: identical public denial for directory, file and missing path`);
          assert.ok(
            [DiscoveryErrorCode.AUTHORIZATION_REQUIRED, DiscoveryErrorCode.AUTHORIZATION_DENIED].includes(
              (JSON.parse(seen[0] ?? '{}') as { code: DiscoveryErrorCode }).code,
            ),
          );
        }
      }
    } finally {
      spy.restore();
    }
  });
});

test('a first-contact denial creates no inventory record and no evidence; repeated unauthorized requests leave the inventory empty', async () => {
  await withSandbox(async ({ root, base }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    await put(join(base, 'a-file.txt'), 'x');
    const deps = makeDeps();
    const targets = [root, join(base, 'a-file.txt'), join(base, 'does-not-exist')];
    const messages = new Set<string>();
    for (let i = 0; i < 50; i++) {
      for (const root of targets) {
        const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(failClosed()));
        assert.equal(run.ok, false);
        if (!run.ok) messages.add(JSON.stringify(run.error));
      }
    }
    assert.equal(messages.size, 1, 'one public denial regardless of what the path is');
    assert.equal(deps.inventory.list().length, 0);
  });
});

test('probing and recording happen only AFTER the first allow: nothing exists at decision time, the gate is asked per operation, and never cached', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const deps = makeDeps();
    const spy = installFsSpy();
    try {
      spy.watch([root]);
      const asked: { op: string; permission: string; fsCalls: number; records: number }[] = [];
      const inner = allowRoot(root);
      const gate: AuthorizationPort = {
        decide: async (req: AuthorizationRequest) => {
          asked.push({ op: req.operation, permission: req.permission, fsCalls: spy.calls.length, records: deps.inventory.list().length });
          return inner.decide(req);
        },
      };
      const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(gate));
      assert.ok(run.ok);
      assert.deepEqual(
        asked.map((a) => a.op),
        ['detect', 'validate_connection', 'discover'],
        'one separate decision per operation',
      );
      assert.ok(asked.every((a) => a.permission === 'filesystem.list'));
      assert.equal(asked[0]?.fsCalls, 0, 'no filesystem call on the requested path before the first decision');
      assert.equal(asked[0]?.records, 0, 'no inventory record before the first decision');
      assert.ok(spy.calls.length > 0, 'filesystem is touched after authorization');
    } finally {
      spy.restore();
    }
  });
});

test('once-style grants: every operation consumes one allow; decisions are not reused to keep a run going', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const budgeted = (allowances: number): AuthorizationPort & { used: () => number } => {
      let used = 0;
      const inner = allowRoot(root);
      return {
        used: () => used,
        decide: async (req) => {
          if (used >= allowances) return { effect: 'prompt', reason: 'allowance consumed' };
          used += 1;
          return inner.decide(req);
        },
      };
    };
    // 0 allowances: denied, no record.
    const none = makeDeps();
    const r0 = await discoverSource(none, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(budgeted(0)));
    assert.equal(r0.ok, false);
    assert.equal(none.inventory.list().length, 0);
    // 1 allowance: detect succeeds (a record exists), validate is denied, nothing is read.
    const one = makeDeps();
    const g1 = budgeted(1);
    const r1 = await discoverSource(one, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(g1));
    assert.ok(r1.ok);
    if (r1.ok) {
      assert.equal(r1.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
      assert.equal(r1.value.record.status, 'authorization_required');
      assert.equal(r1.value.evidence.length, 0);
    }
    assert.equal(g1.used(), 1);
    // 3 allowances: complete run.
    const three = makeDeps();
    const g3 = budgeted(3);
    const r3 = await discoverSource(three, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(g3));
    assert.ok(r3.ok && r3.value.evidence.length > 0);
    assert.equal(g3.used(), 3);
  });
});

test('a symlinked root authorized only by its lexical path is re-authorized against the resolved path, and denied without enumerating', async () => {
  await withSandbox(async ({ root, base }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const link = join(base, 'link-to-approved');
    await symlink(root, link);
    const spy = installFsSpy();
    try {
      const deps = makeDeps();
      const lexicalOnly = new DevelopmentOperatorAuthorization([{ permission: 'filesystem.list', path: link }]);
      spy.watch([link, root]);
      const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: scopeOf(link) }, ctxFor(lexicalOnly));
      assert.equal(run.ok, false);
      if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
      assert.equal(deps.inventory.list().length, 0, 'no record when the resolved path is not authorized');
      assert.equal(
        spy.calls.filter((c) => c.fn === 'readdir' || c.fn === 'open').length,
        0,
        'nothing under the resolved path is listed or read',
      );
      assert.equal(JSON.stringify(run).includes(root), false, 'the resolved target is not disclosed');

      // Both the lexical and the resolved path authorized: succeeds, two decisions per operation.
      const both = new DevelopmentOperatorAuthorization([
        { permission: 'filesystem.list', path: link },
        { permission: 'filesystem.list', path: root },
      ]);
      const asked: string[] = [];
      const counting: AuthorizationPort = {
        decide: async (req) => {
          asked.push(`${req.operation}:${req.scope.kind === 'path' ? req.scope.path : '?'}`);
          return both.decide(req);
        },
      };
      const ok = await discoverSource(makeDeps(), { sourceType: 'local_filesystem', scope: scopeOf(link) }, ctxFor(counting));
      assert.ok(ok.ok && ok.value.evidence.length > 0);
      assert.deepEqual(asked, [
        `detect:${link}`,
        `detect:${root}`,
        `validate_connection:${link}`,
        `validate_connection:${root}`,
        `discover:${link}`,
        `discover:${root}`,
      ]);
    } finally {
      spy.restore();
    }
  });
});

test('caller-supplied declarations, principal claims and an authority string cannot turn a denial into an allow', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const declared = scopeOf(root, {
      permissions: ['filesystem.list', 'filesystem.read'],
      requiredPermissions: [],
      grants: [{ permission: 'filesystem.list', path: root }],
      effect: 'allow',
    });
    const spy = installFsSpy();
    try {
      for (const [entryName, run] of entryPoints) {
        spy.watch([root]);
        // A caller-claimed principal is not an authenticated one (M2.1): rejected for identity, before any gate or probe.
        const spoofed = { ...ctxFor(failClosed()), principal: { kind: 'human', id: 'ceo@victim.example' } } as ReturnType<typeof ctxFor>;
        const rSpoof = await run(declared, spoofed);
        assert.equal(rSpoof.ok, false, entryName);
        assert.equal(rSpoof.error?.code, DiscoveryErrorCode.UNAUTHENTICATED, entryName);
        // Control: a genuinely authenticated caller reaches the gate, which (fail-closed) still answers `required`.
        const r = await run(declared, ctxFor(failClosed()));
        assert.equal(r.ok, false, entryName);
        assert.equal(r.error?.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED, entryName);
        assert.equal(spy.calls.length, 0, `${entryName}: still no probing`);
      }
      // A DENY or PROMPT that names the 'platform' authority stays a denial.
      for (const [, makeGate] of denialGates.slice(1, 3)) {
        const deps = makeDeps();
        const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: declared }, ctxFor(makeGate()));
        assert.equal(run.ok, false);
        assert.equal(deps.inventory.list().length, 0);
      }
    } finally {
      spy.restore();
    }
  });
});

test('a throwing gate fails closed at every entry point without leaking its message or the requested path', async () => {
  await withSandbox(async ({ root }) => {
    const boom: AuthorizationPort = {
      decide: async () => {
        throw new Error(`database password is hunter2 at ${root}/.secret`);
      },
    };
    const spy = installFsSpy();
    try {
      for (const [entryName, run] of entryPoints) {
        spy.watch([root]);
        const r = await run(scopeOf(root), ctxFor(boom));
        assert.equal(r.ok, false, entryName);
        assert.equal(r.error?.code, DiscoveryErrorCode.INTERNAL, entryName);
        const text = JSON.stringify(r.error);
        assert.equal(text.includes('hunter2'), false, entryName);
        assert.equal(text.includes(root), false, entryName);
        assert.equal(spy.calls.length, 0, `${entryName}: no probing after a failed decision`);
      }
    } finally {
      spy.restore();
    }
  });
});

test('string-shape violations are rejected without consulting the gate or the filesystem (they reveal nothing about the environment)', async () => {
  const spy = installFsSpy();
  try {
    const seen: AuthorizationRequest[] = [];
    const gate: AuthorizationPort = {
      decide: async (req) => {
        seen.push(req);
        return { effect: 'prompt', reason: 'x' };
      },
    };
    for (const bad of ['relative/path', '', '/', '//', '/a/../b', '/a/./b', '/a//b', '/a\0b']) {
      for (const [entryName, run] of entryPoints) {
        spy.watch(['/']);
        const r = await run(scopeOf(bad), ctxFor(gate));
        assert.equal(r.ok, false, `${entryName} ${JSON.stringify(bad)}`);
        assert.equal(r.error?.code, DiscoveryErrorCode.INVALID_SCOPE, `${entryName} ${JSON.stringify(bad)}`);
        assert.equal(spy.calls.length, 0, `${entryName} ${JSON.stringify(bad)}: no filesystem call`);
      }
    }
    assert.equal(seen.length, 0, 'the gate is not consulted for malformed input');
  } finally {
    spy.restore();
  }
});

test('behaviour that must not change: list vs read stay separate, and an authorized scan still works end to end', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const deps = makeDeps();
    const listOnly = allowRoot(root, ['filesystem.list']);
    const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(listOnly));
    assert.ok(run.ok && run.value.evidence.length > 0);
    const acq = await connector.acquireContent(
      {
        sourceId: run.ok ? run.value.record.source.sourceId : SourceId('x'),
        kind: 'document_content',
        resourceKeys: ['a.txt'],
        scope: scopeOf(root),
      },
      ctxFor(listOnly),
    );
    assert.equal(acq.ok, false);
    if (!acq.ok) assert.equal(acq.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  });
});

test('the package test script executes this regression file', async () => {
  const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as {
    scripts: { test: string };
  };
  assert.ok(pkg.scripts.test.includes('test/preauthorization.test.ts'));
});
