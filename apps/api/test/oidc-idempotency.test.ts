import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { withTempDir, TestServer } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import { createOidcVerifier } from '../src/auth/oidc/verifier.js';
import { loadOidcConfig } from '../src/auth/oidc/config.js';
import { AUDIENCE, TestIdp } from './oidc-test-idp.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * OIDC callers go through the same M2 ownership, M3 approval and M6 idempotency boundaries as API-key
 * callers, and authentication is re-evaluated on EVERY request, including an idempotent replay: a
 * revoked binding cannot replay a previous result with the same token and the same Idempotency-Key.
 */

interface RunWire {
  readonly workflowExecutionId: string;
  readonly status: string;
}

const KEY = 'oidc-start-key-0001';
const INPUT = { screening_score: 90, settlement_amount: 800 };

async function withOidcEnv(
  fn: (env: {
    idp: TestIdp;
    server: TestServer;
    bindings: FsIdentityBindingStore;
    workspace: WorkspaceRecord;
    compilationId: string;
    as: (
      token: string,
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => ReturnType<TestServer['request']>;
    bind: (sub: string, identityId: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const idp = await TestIdp.start();
  try {
    await withTempDir('xo-oidc-idem-data-', async (dataDir) => {
      await withTempDir('xo-oidc-idem-ws-', async (workspacesDir) => {
        await withTempDir('xo-oidc-idem-bind-', async (bindDir) => {
          const bindings = new FsIdentityBindingStore(bindDir);
          const config = loadOidcConfig({ XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
          assert.ok(config);
          const verifier = createOidcVerifier(config, { jwksCooldownMs: 0, discoveryRetryMs: 0 });
          const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, oidc: { verifier, bindings } });
          const as: (
            token: string,
            method: string,
            path: string,
            body?: unknown,
            headers?: Record<string, string>,
          ) => ReturnType<TestServer['request']> = (token, method, path, body, headers = {}) =>
            server.request(method, path, body, { authorization: `Bearer ${token}`, ...headers }, { skipAuth: true });
          const bind = async (sub: string, identityId: string): Promise<void> => {
            const r = await bindings.create({
              bindingId: computeBindingId(idp.issuer, sub),
              issuer: idp.issuer,
              subject: sub,
              identityId,
              principalKind: 'human',
              createdAt: new Date().toISOString(),
            });
            assert.ok(r.ok);
          };
          try {
            await bind('alice-sub', 'alice');
            const created = await as(await idp.sign({ sub: 'alice-sub' }), 'POST', '/workspaces', {});
            assert.equal(created.status, 201, created.bodyText);
            const workspace = created.json<WorkspaceRecord>();
            const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
            await fn({ idp, server, bindings, workspace, compilationId, as, bind });
          } finally {
            await server.stop();
          }
        });
      });
    });
  } finally {
    await idp.stop();
  }
}

test('OIDC callers cannot bypass M3 approval or M2 ownership; once approved, an idempotent start replays', async () => {
  await withOidcEnv(async ({ idp, workspace, compilationId, as, bind }) => {
    const alice = await idp.sign({ sub: 'alice-sub' });
    const ws = `/workspaces/${workspace.workspaceId}`;

    const wfs = await as(alice, 'GET', `${ws}/workflows`);
    const workflowId = wfs
      .json<{ workflows: { workflowId: string; steps: { capabilityId: string }[] }[] }>()
      .workflows.find((w) => w.steps[0]?.capabilityId === IDS.hitlA)?.workflowId;
    assert.ok(workflowId);
    const startPath = `${ws}/workflows/${workflowId}/executions`;
    const start = (token: string): ReturnType<typeof as> =>
      as(token, 'POST', startPath, { compilationId, input: INPUT }, { 'idempotency-key': KEY });
    const runs = async (token: string): Promise<RunWire[]> =>
      (await as(token, 'GET', `${ws}/workflow-executions`)).json<{ workflowExecutions: RunWire[] }>().workflowExecutions;

    // M3: an unapproved chain is refused for an OIDC caller exactly as for a key caller, and creates nothing.
    const refused = await start(alice);
    assert.notEqual(refused.status, 201, 'an unapproved chain must not start');
    assert.notEqual(refused.status, 401);
    assert.equal((await runs(alice)).length, 0);

    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) {
      const res = await as(alice, 'POST', `${ws}/compilations/${compilationId}/capabilities/${id}/approve`);
      assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    }

    const first = await start(alice);
    assert.equal(first.status, 201, first.bodyText);
    const run = first.json<RunWire>();
    const replay = await start(alice);
    assert.equal(replay.status, 200, replay.bodyText);
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.equal(replay.json<RunWire>().workflowExecutionId, run.workflowExecutionId);

    // M2/M6: a different authenticated, bound identity is not the owner. It cannot see or replay alice's run.
    await bind('bob-sub', 'bob');
    const bob = await idp.sign({ sub: 'bob-sub' });
    const intruder = await start(bob);
    assert.equal(intruder.status, 404, intruder.bodyText);
    assert.equal(intruder.headers['idempotent-replayed'], undefined);
  });
});

test('after revocation the same token and Idempotency-Key get 401 — no replayed result, no new run — and re-binding restores the original run', async () => {
  await withOidcEnv(async ({ idp, bindings, workspace, compilationId, as }) => {
    const alice = await idp.sign({ sub: 'alice-sub' });
    const ws = `/workspaces/${workspace.workspaceId}`;
    const workflowId = (await as(alice, 'GET', `${ws}/workflows`))
      .json<{ workflows: { workflowId: string; steps: { capabilityId: string }[] }[] }>()
      .workflows.find((w) => w.steps[0]?.capabilityId === IDS.hitlA)?.workflowId;
    assert.ok(workflowId);
    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) {
      assert.ok((await as(alice, 'POST', `${ws}/compilations/${compilationId}/capabilities/${id}/approve`)).status < 300);
    }
    const startPath = `${ws}/workflows/${workflowId}/executions`;
    const start = (): ReturnType<typeof as> => as(alice, 'POST', startPath, { compilationId, input: INPUT }, { 'idempotency-key': KEY });
    const first = await start();
    assert.equal(first.status, 201, first.bodyText);
    const runId = first.json<RunWire>().workflowExecutionId;

    assert.ok((await bindings.revoke(idp.issuer, 'alice-sub')).ok);
    const afterRevoke = await start();
    assert.equal(afterRevoke.status, 401);
    assert.equal(afterRevoke.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_IDENTITY_UNBOUND);
    assert.equal(afterRevoke.headers['idempotent-replayed'], undefined, 'a refused request is never presented as a replay');
    assert.ok(!afterRevoke.bodyText.includes(runId), 'the earlier result is not disclosed');

    // The operator binds the identity again: the original run is still there, exactly one, and replays.
    assert.ok(
      (
        await bindings.create({
          bindingId: computeBindingId(idp.issuer, 'alice-sub'),
          issuer: idp.issuer,
          subject: 'alice-sub',
          identityId: 'alice',
          principalKind: 'human',
          createdAt: new Date().toISOString(),
        })
      ).ok,
    );
    const restored = await start();
    assert.equal(restored.status, 200, restored.bodyText);
    assert.equal(restored.json<RunWire>().workflowExecutionId, runId);
    const all = (await as(alice, 'GET', `${ws}/workflow-executions`)).json<{ workflowExecutions: RunWire[] }>().workflowExecutions;
    assert.equal(all.length, 1, 'the refused request created no run');
  });
});
