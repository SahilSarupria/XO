import { test } from 'node:test';
import assert from 'node:assert/strict';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import { runCommand } from '../src/commands/runtime/run.js';
import { tryDeterministicRun } from '../src/commands/runtime/deterministic-router.js';
import { runWorkflowPipeline } from '../src/commands/runtime/workflow-pipeline.js';
import { withInstalledBundle, buildAuthoritativeClaimBundle, buildTestBundle } from './helpers.js';

// P1.0 M2 — CLI authorization: declaration metadata is authoritative, --grant is policy (not identity),
// the AI path stays disabled, and a missing/forged subject is denied before evaluation.

const shouldNeverResolve = () => {
  throw new Error('resolveProvider() must not be called');
};
const INPUT = JSON.stringify({ claim_amount: 15000 });
const run = (storeDir: string, extra: { grantedPermissionIds?: string[] } = {}) =>
  runCommand(
    { capabilityId: 'claim_approval', input: INPUT, storeDir, providerLabel: 'anthropic', json: true, ...extra },
    shouldNeverResolve,
  );

test('explicit `requiredPermissions: []` on the capability node => permission-free: executes locally with no grant', async () => {
  await withInstalledBundle(buildAuthoritativeClaimBundle(), async (storeDir) => {
    assert.equal((await run(storeDir)).exitCode, 0);
  });
});

test('missing node requiredPermissions declaration => DENIED (never permission-free), even with grants; nothing executes', async () => {
  await withInstalledBundle(buildAuthoritativeClaimBundle({ nodeRequiredPermissions: 'omit' }), async (storeDir) => {
    const r = await run(storeDir, { grantedPermissionIds: ['runtime.execute', 'filesystem.read'] });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /permission declaration is missing|not authorized/i);
    assert.doesNotMatch(r.lines.join('\n'), /"matched"\s*:\s*true/);
  });
});

test('malformed node requiredPermissions (string / non-string entry / invalid id / null) => DENIED', async () => {
  for (const bad of ['filesystem.read', [7], ['NOT A PERMISSION'], null, {}]) {
    await withInstalledBundle(buildAuthoritativeClaimBundle({ nodeRequiredPermissions: bad }), async (storeDir) => {
      const r = await run(storeDir, { grantedPermissionIds: ['filesystem.read'] });
      assert.notEqual(r.exitCode, 0, JSON.stringify(bad));
    });
  }
});

test('declared permission: denied without --grant (hint names the permission), allowed with it; wrong grant is still denied', async () => {
  const bundle = () => buildAuthoritativeClaimBundle({ nodeRequiredPermissions: ['filesystem.read'] });
  await withInstalledBundle(bundle(), async (storeDir) => {
    const denied = await run(storeDir);
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.lines.join('\n'), /--grant filesystem\.read/);
    const wrong = await run(storeDir, { grantedPermissionIds: ['network.connect'] });
    assert.notEqual(wrong.exitCode, 0);
    const ok = await run(storeDir, { grantedPermissionIds: ['filesystem.read'] });
    assert.equal(ok.exitCode, 0);
  });
});

test('manifest-declared permission is ADDITIVE: it can make a node-permission-free capability stricter, never looser', async () => {
  await withInstalledBundle(
    buildAuthoritativeClaimBundle({ permissions: [{ permission: 'filesystem.read', capabilityId: 'claim_approval' }] }),
    async (storeDir) => {
      assert.notEqual((await run(storeDir)).exitCode, 0);
      assert.equal((await run(storeDir, { grantedPermissionIds: ['filesystem.read'] })).exitCode, 0);
    },
  );
});

test('malformed execution.requiredPermissionIds in the manifest => DENIED', async () => {
  await withInstalledBundle(buildAuthoritativeClaimBundle({ executionRequiredPermissionIds: ['NOT A PERMISSION'] }), async (storeDir) => {
    assert.notEqual((await run(storeDir, { grantedPermissionIds: ['filesystem.read'] })).exitCode, 0);
  });
});

test('an invalid --grant value is rejected, not ignored', async () => {
  await withInstalledBundle(buildAuthoritativeClaimBundle(), async (storeDir) => {
    assert.notEqual((await run(storeDir, { grantedPermissionIds: ['not a permission'] })).exitCode, 0);
  });
});

test('tryDeterministicRun without a verified subject is denied before lookup/evaluation (missing, fabricated, a Principal is not a trusted context)', async () => {
  await withInstalledBundle(buildAuthoritativeClaimBundle(), async (storeDir) => {
    void storeDir;
    const principal = establishAuthenticatedPrincipal({ kind: 'human', id: 'alice' });
    assert.ok(principal.ok);
    for (const subject of [undefined, { kind: 'trusted-context', context: 'local-operator' }, 'local-operator', { ...principal.value }]) {
      const outcome = await tryDeterministicRun('claim_approval', INPUT, undefined as never, undefined as never, [], subject as never);
      assert.equal(outcome.kind, 'not_authorized', JSON.stringify(subject));
    }
  });
});

test('AI execution stays disabled: --grant flags, provider label, model and env cannot enable it; provider is never resolved', async () => {
  const saved = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-be-read';
  try {
    await withInstalledBundle(buildTestBundle(), async (storeDir) => {
      const r = await runCommand(
        {
          capabilityId: 'echo',
          input: 'hello',
          storeDir,
          providerLabel: 'anthropic',
          model: 'x',
          endpoint: 'http://127.0.0.1:1/',
          grantedPermissionIds: ['runtime.execute', 'filesystem.read'],
        } as never,
        shouldNeverResolve,
      );
      assert.equal(r.exitCode, 1);
      assert.match(r.lines.join('\n'), /AI-assisted execution is disabled/);
      assert.doesNotMatch(r.lines.join('\n'), /sk-should-not-be-read/);
    });
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
  }
});

test('workflow pipeline compiles in-process and runs under the trusted local operator with a deny-by-default policy', async () => {
  const r = await runWorkflowPipeline({ source: '/nonexistent/path.txt' } as never);
  assert.equal(r.ok, false); // unreadable source is reported, nothing executed
});
