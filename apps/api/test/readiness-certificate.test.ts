/**
 * PX-7 — readiness certificates and the start gate: a certificate is issued from the server's own recomputation, a start
 * presenting it re-verifies every bound digest, a stale or not-ready certificate is refused, and a workspace can require
 * one. A changed contract makes a sign-off stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

interface Cert {
  certificateId: string;
  status: string;
  gates: { id: string; outcome: string }[];
  scope: { candidateWorkflowId: string };
}

test('issue → NEEDS_REVIEW until approved → READY → start with it; stale and required certificates are refused', async () => {
  await withTempDir('xo-api-cert-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const gen = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'Ship a release', needs: ['Run the full test suite'] },
        })
      ).json<{
        definition: { definitionId: string; candidateWorkflowId: string };
      }>().definition;
      const issue = async (body: object = {}): Promise<Cert> => {
        const r = await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/readiness`, body);
        assert.equal(r.status, 201, r.bodyText);
        return r.json<Cert>();
      };
      const start = (certificateId?: string) =>
        server.request('POST', `/workspaces/${ws}/workflows/${gen.candidateWorkflowId}/executions`, {
          compilationId: cid,
          input: {},
          ...(certificateId !== undefined ? { certificateId } : {}),
        });
      // UW-7 (ADR 0033): a certified procedure now carries a not-done escalation after each person's task, a construct only the
      // canonical Workflow IR runtime executes. A READY certificate therefore starts the run there; the composed-workflow start
      // names the route (PX-10, one certificate, one meaning) instead of running it on the other engine.
      const startWithCertificate = async (certificateId: string) => {
        const composed = await start(certificateId);
        assert.equal(composed.status, 409, composed.bodyText);
        assert.equal(composed.json<{ error: { code: string } }>().error.code, 'XO_WORKFLOW_REQUIRES_IR_RUNTIME');
        return server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/runs`, { input: {}, certificateId });
      };

      const first = await issue();
      assert.equal(first.status, 'NEEDS_REVIEW');
      assert.equal(first.gates.find((g) => g.id === 'authorization')!.outcome, 'review');
      const notReady = await start(first.certificateId);
      assert.equal(notReady.status, 409);
      assert.equal(notReady.json<{ error: { code: string } }>().error.code, 'XO_READINESS_CERTIFICATE_REFUSED');

      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        assert.equal(
          (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`))
            .status,
          200,
        );

      const ready = await issue();
      assert.equal(ready.status, 'READY', JSON.stringify(ready.gates.filter((g) => g.outcome !== 'pass')));
      assert.equal(
        (await server.request('GET', `/workspaces/${ws}/readiness-certificates/${ready.certificateId}/verify`)).json<{
          startAllowed: boolean;
        }>().startAllowed,
        true,
      );
      const started = await startWithCertificate(ready.certificateId);
      assert.ok(started.status === 201 || started.status === 200, started.bodyText);

      // Require certificates: a start without one is refused.
      const patched = await server.request('PUT', `/workspaces/${ws}/settings`, { trust: { requireReadinessCertificate: true } });
      assert.equal(patched.status, 200, patched.bodyText);
      const without = await start();
      assert.equal(without.status, 409);
      assert.equal(without.json<{ error: { code: string } }>().error.code, 'XO_READINESS_CERTIFICATE_REQUIRED');

      // Approving knowledge changes the pinned knowledge state: the certificate is stale.
      const proposal = (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/knowledge-change-sets`)).json<{
        changeSet: { changeSetId: string };
      }>();
      assert.equal(
        (
          await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${proposal.changeSet.changeSetId}/approve`, {
            reason: 'ok',
          })
        ).status,
        200,
      );
      const verify = (await server.request('GET', `/workspaces/${ws}/readiness-certificates/${ready.certificateId}/verify`)).json<{
        startAllowed: boolean;
        reasons: string[];
      }>();
      assert.equal(verify.startAllowed, false);
      assert.ok(
        verify.reasons.some((r) => r.includes('knowledge state changed')),
        JSON.stringify(verify.reasons),
      );
      const stale = await start(ready.certificateId);
      assert.equal(stale.status, 409);
      assert.equal(stale.json<{ error: { code: string } }>().error.code, 'XO_READINESS_CERTIFICATE_REFUSED');

      // A fresh certificate against the new state allows the start again.
      const fresh = await issue();
      assert.equal(fresh.status, 'READY');
      const again = await startWithCertificate(fresh.certificateId);
      assert.ok(again.status === 201 || again.status === 200, again.bodyText);

      const listed = (await server.request('GET', `/workspaces/${ws}/readiness-certificates`)).json<{ certificates: Cert[] }>()
        .certificates;
      assert.equal(listed.length, 3);
      assert.equal((await start('wrc_000000000000000000000000')).status, 404);
    } finally {
      await server.stop();
    }
  });
});
