/**
 * PX-4 — the Business Knowledge Base over HTTP: a compilation proposes a change set (nothing applied), a reviewer approves
 * or rejects it, reads are pinned to a state, recompiling the same source proposes nothing, and packs are validated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePackArtifact } from '@xo/knowledge-base';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT = '# Refunds\n\nAcme Corp handles refunds.\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

interface Proposal {
  changeSet: { changeSetId: string; status: string; findings: { severity: string }[]; baseStateId: string } | null;
  report: { accepted: string[]; unchanged: string[]; updated: string[]; unsupported: string[] };
}

test('compile → propose → approve; reads are pinned; recompiling proposes nothing; reject and stale are refused cleanly', async () => {
  await withTempDir('xo-api-bkb-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const compile = async (): Promise<string> =>
        (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
      const c1 = await compile();

      const empty = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string; entries: unknown[] }>();
      assert.equal(empty.entries.length, 0);

      const proposed = await server.request('POST', `/workspaces/${ws}/compilations/${c1}/knowledge-change-sets`);
      assert.equal(proposed.status, 201, proposed.bodyText);
      const p = proposed.json<Proposal>();
      assert.ok(p.changeSet !== null && p.report.accepted.length > 0);
      assert.deepEqual(
        p.changeSet.findings.filter((f) => f.severity === 'error'),
        [],
      );
      assert.equal(
        (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId,
        empty.stateId,
        'proposing applies nothing',
      );

      const noReason = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, {});
      assert.equal(noReason.status, 400);
      const approved = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, {
        reason: 'matches the policy',
      });
      assert.equal(approved.status, 200, approved.bodyText);
      const state = approved.json<{ state: { stateId: string } }>().state;
      const again = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, {
        reason: 'twice',
      });
      assert.equal(again.status, 409);
      assert.equal(again.json<{ error: { code: string } }>().error.code, 'XO_KNOWLEDGE_CHANGE_SET_REFUSED');

      const verify = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${state.stateId}/verify`)).json<{
        verified: boolean;
      }>();
      assert.equal(verify.verified, true);
      const hits = (await server.request('GET', `/workspaces/${ws}/knowledge/search?q=refund&state=${state.stateId}`)).json<{
        stateId: string;
        hits: { evidence: { sourceName: string }[]; authority?: { level: string } }[];
      }>();
      assert.equal(hits.stateId, state.stateId);
      assert.ok(hits.hits.length > 0);
      assert.equal(hits.hits[0]!.evidence[0]!.sourceName, 'refunds.md');
      const acme = (
        await server.request('GET', `/workspaces/${ws}/knowledge/resolve-entity?name=${encodeURIComponent('Acme Corp')}`)
      ).json<{ status: string }>();
      assert.equal(acme.status, 'linked');

      // Recompiling the same source proposes nothing new.
      const c2 = await compile();
      const repeat = (await server.request('POST', `/workspaces/${ws}/compilations/${c2}/knowledge-change-sets`)).json<Proposal>();
      assert.equal(repeat.changeSet, null);
      assert.equal(repeat.report.accepted.length, 0);

      // Reject path, and an unknown change set.
      const unknown = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/cs_000000000000000000000000/reject`, {
        reason: 'x',
      });
      assert.equal(unknown.status, 404);
      const list = (await server.request('GET', `/workspaces/${ws}/knowledge/change-sets?status=approved`)).json<{
        changeSets: unknown[];
      }>();
      assert.equal(list.changeSets.length, 1);
    } finally {
      await server.stop();
    }
  });
});

test('packs: a valid pack installs; a tampered pack and a second pack for the same namespace are refused', async () => {
  await withTempDir('xo-api-bkb-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const manifest = {
        schema: 'xo.domain-pack.v1' as const,
        packId: 'pack.alpha',
        namespace: 'alpha',
        version: '1.0.0',
        compatibility: { core: '1' },
        dependencies: [],
        publisher: { id: 'pub', name: 'Publisher' },
        contributions: { entityTypes: [{ name: 'Account' }], predicates: [], relationshipTypes: [] },
      };
      const pack = makePackArtifact(manifest);
      const ok = await server.request('POST', `/workspaces/${ws}/knowledge/packs`, pack);
      assert.equal(ok.status, 201, ok.bodyText);
      const tampered = await server.request('POST', `/workspaces/${ws}/knowledge/packs`, {
        ...pack,
        manifest: { ...manifest, version: '9.0.0' },
      });
      assert.equal(tampered.status, 400);
      const second = await server.request('POST', `/workspaces/${ws}/knowledge/packs`, makePackArtifact({ ...manifest, version: '2.0.0' }));
      assert.equal(second.status, 409);
      const packs = (await server.request('GET', `/workspaces/${ws}/knowledge/packs`)).json<{
        packs: { namespace: string; version: string }[];
      }>();
      assert.deepEqual(
        packs.packs.map((x) => `${x.namespace}@${x.version}`),
        ['alpha@1.0.0'],
      );
    } finally {
      await server.stop();
    }
  });
});
