// UW-1 — the instance's single authorization point (HTTP routes and the scheduler share it): the persisted operator policy applies,
// a code-supplied DENY wins over a file ALLOW, and a broken policy file suspends operator ALLOWs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { establishAuthenticatedPrincipal, Permissions, RuleBasedPolicy, toPrincipalSnapshot } from '@xo/permissions';
import { createAuthorizationPoint } from '../src/auth/authorization-point.js';
import { writeInstancePolicy } from '../src/auth/instance-policy.js';
import { WORKSPACE_REQUESTER } from '../src/workspace/authorizer.js';
import { withTempDir } from './test-helpers.js';

const PURGE = Permissions.audit.purge;

async function decide(point: ReturnType<typeof createAuthorizationPoint>, principalId: string): Promise<string> {
  const principal = establishAuthenticatedPrincipal({ kind: 'service', id: principalId });
  assert.ok(principal.ok);
  const decision = await point.permissionManager.check({
    permission: PURGE,
    requester: WORKSPACE_REQUESTER,
    principal: toPrincipalSnapshot(principal.value),
  });
  return decision.effect;
}

test('the persisted operator policy decides; a code-supplied DENY overrides a file ALLOW; stop() ends reloading', async () => {
  await withTempDir('xo-authz-point-', async (dir) => {
    const file = join(dir, '_instance', 'policy.json');
    const written = await writeInstancePolicy(file, [{ id: 'p', effect: 'ALLOW', match: { permission: PURGE, principalId: 'ops' } }], 0);
    assert.ok(written.ok, written.ok ? undefined : written.error.message);
    const point = createAuthorizationPoint({ dataRootDir: dir, reloadMs: 0 });
    await point.instancePolicy.reload();
    assert.equal(await decide(point, 'ops'), 'allow');
    assert.notEqual(await decide(point, 'someone-else'), 'allow');

    const vetoed = createAuthorizationPoint({
      dataRootDir: dir,
      reloadMs: 0,
      permissionPolicy: new RuleBasedPolicy([{ id: 'veto', effect: 'DENY', match: { permission: PURGE } }]),
    });
    await vetoed.instancePolicy.reload();
    assert.notEqual(await decide(vetoed, 'ops'), 'allow');
    point.stop();
    vetoed.stop();
  });
});

test('a broken policy file suspends operator ALLOWs and reports it', async () => {
  await withTempDir('xo-authz-point-', async (dir) => {
    await mkdir(join(dir, '_instance'), { recursive: true });
    await writeFile(join(dir, '_instance', 'policy.json'), '{ broken');
    const errors: string[] = [];
    const point = createAuthorizationPoint({ dataRootDir: dir, reloadMs: 0, onError: (m) => errors.push(m) });
    await point.instancePolicy.reload();
    assert.notEqual(await decide(point, 'ops'), 'allow');
    assert.ok(
      errors.some((m) => m.startsWith('instance policy suspended')),
      errors.join('\n'),
    );
    point.stop();
  });
});
