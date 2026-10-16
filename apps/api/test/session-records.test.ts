import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { AUDIENCE, TestIdp } from './oidc-test-idp.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import { createOidcVerifier } from '../src/auth/oidc/verifier.js';
import { loadOidcConfig } from '../src/auth/oidc/config.js';
import { createSessionAuth } from '../src/auth/session/bundle.js';
import { loadSessionAuthConfig } from '../src/auth/session/config.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

const CLIENT_ID = '1234567890-xotest.apps.googleusercontent.com';

/**
 * All three credential types at once against one server: API key, provider-JWT OIDC, and XO session. The same XO
 * principal ("alice") is reachable by each, so the only thing that differs between the records they create is HOW
 * the caller authenticated, and that is what the records must say: credential type and canonical issuer, nothing
 * else (no token, no subject, no claim).
 */
test('execution and workflow records carry credential type and issuer for api-key, oidc and session callers, and nothing sensitive', async () => {
  const idp = await TestIdp.start();
  const sessionsDir = await mkdtemp(join(tmpdir(), 'xo-rec-sessions-'));
  try {
    await withTempDir('xo-rec-data-', async (dataDir) => {
      await withTempDir('xo-rec-ws-', async (workspacesDir) => {
        await withTempDir('xo-rec-bind-', async (bindDir) => {
          const bindings = new FsIdentityBindingStore(bindDir);
          for (const sub of ['oidc-alice', 'g-alice']) {
            assert.ok(
              (
                await bindings.create({
                  bindingId: computeBindingId(idp.issuer, sub),
                  issuer: idp.issuer,
                  subject: sub,
                  identityId: 'alice',
                  principalKind: 'human',
                  createdAt: new Date().toISOString(),
                })
              ).ok,
            );
          }
          const oidcConfig = loadOidcConfig({ XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
          assert.ok(oidcConfig);
          const sessionConfig = loadSessionAuthConfig({
            XO_API_GOOGLE_CLIENT_ID: CLIENT_ID,
            XO_API_GOOGLE_ISSUER: idp.issuer,
            XO_API_SESSIONS_DIR: sessionsDir,
            XO_API_OIDC_BINDINGS_DIR: bindDir,
          });
          assert.ok(sessionConfig);
          const sessionAuth = createSessionAuth(sessionConfig, { bindings, verifierTuning: { jwksCooldownMs: 0 } });
          const server = await TestServer.start(
            {
              workspaceDataDir: dataDir,
              workspacesDir,
              oidc: { verifier: createOidcVerifier(oidcConfig, { jwksCooldownMs: 0 }), bindings },
              sessionAuth,
            },
            'alice',
          );
          try {
            const call = (
              method: string,
              path: string,
              bearer: string,
              body?: unknown,
              headers: Record<string, string> = {},
            ): ReturnType<TestServer['request']> =>
              server.request(method, path, body, { authorization: `Bearer ${bearer}`, ...headers }, { skipAuth: true });

            // A session for g-alice, obtained through the real endpoints.
            const ch = (await server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true })).json<{
              challengeId: string;
              nonce: string;
            }>();
            const idToken = await idp.sign({
              sub: 'g-alice',
              aud: CLIENT_ID,
              claims: { nonce: ch.nonce, email: 'leak-check@example.com' },
            });
            const ex = await server.request('POST', '/auth/session', { challengeId: ch.challengeId, idToken }, {}, { skipAuth: true });
            assert.equal(ex.status, 201);
            const sessionToken = ex.json<{ accessCredential: string }>().accessCredential;
            const oidcToken = await idp.sign({ sub: 'oidc-alice' });
            const apiKey = server.apiKey;

            const created = await call('POST', '/workspaces', apiKey, {});
            assert.equal(created.status, 201);
            const workspace = created.json<WorkspaceRecord>();
            const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
            const ws = `/workspaces/${workspace.workspaceId}`;
            const wf = (await call('GET', `${ws}/workflows`, apiKey))
              .json<{ workflows: { workflowId: string; steps: { capabilityId: string }[] }[] }>()
              .workflows.find((w) => w.steps[0]?.capabilityId === IDS.hitlA);
            assert.ok(wf);
            for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC])
              assert.ok((await call('POST', `${ws}/compilations/${compilationId}/capabilities/${id}/approve`, apiKey)).status < 300);

            const expected: Array<[string, string, object]> = [
              ['api-key', apiKey, { credential: 'api-key' }],
              ['oidc', oidcToken, { credential: 'oidc', issuer: idp.issuer }],
              ['session', sessionToken, { credential: 'session', issuer: idp.issuer }],
            ];
            const runIds: Array<[string, string, object]> = [];
            for (const [name, bearer, auth] of expected) {
              const res = await call(
                'POST',
                `${ws}/workflows/${wf.workflowId}/executions`,
                bearer,
                { compilationId, input: { screening_score: 90, settlement_amount: 800 } },
                { 'idempotency-key': `rec-${name}-key-001` },
              );
              assert.equal(res.status, 201, `${name}: ${res.bodyText.slice(0, 120)}`);
              runIds.push([name, res.json<{ workflowExecutionId: string }>().workflowExecutionId, auth]);
            }
            const list = (await call('GET', `${ws}/workflow-executions`, apiKey)).json<{
              workflowExecutions: Array<{ workflowExecutionId: string; authentication?: unknown; initiator?: { id: string } }>;
            }>().workflowExecutions;
            for (const [name, id, auth] of runIds) {
              const rec = list.find((r) => r.workflowExecutionId === id);
              assert.ok(rec, name);
              assert.deepEqual(rec.authentication, auth, `${name}: authentication stamped on the workflow record`);
              assert.equal(rec.initiator?.id, 'alice', `${name}: the principal is the bound one`);
            }
            // Nothing sensitive in any record that was written.
            const everything = JSON.stringify(list) + (await call('GET', `${ws}/executions`, apiKey).then((r) => r.bodyText));
            for (const secret of [sessionToken, oidcToken, apiKey, idToken, 'leak-check@example.com', 'g-alice', 'oidc-alice'])
              assert.ok(!everything.includes(secret), 'sensitive value in a record');

            // Coexistence: all three credential types still authenticate side by side.
            for (const [, bearer] of expected) assert.equal((await call('GET', '/workspaces', bearer)).status, 200);
          } finally {
            await server.stop();
          }
        });
      });
    });
  } finally {
    await idp.stop();
    await rm(sessionsDir, { recursive: true, force: true });
  }
});
