/**
 * G-3 (Revision 4, UW-13, ADR 0053): domain isolation. The V1 flow's safety behaviour must not depend on which Domain Knowledge Pack is
 * installed. The same flow runs three times (no pack, an unrelated pack, a pack whose entity types are the ones the flow talks about),
 * each certified after the pack is installed (RX-1d), and the behaviour that keeps it safe is compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePackArtifact } from '@xo/knowledge-base';
import { fakeGmail, newMailbox } from '../../../packages/connectors/test/mail-fakes.js';
import { withTempDir, type TestServer } from './test-helpers.js';
import { CLIENTS, certificateWorkspace, type Preview } from './v1-fixtures.js';

const pack = (namespace: string, entityTypes: string[]) =>
  makePackArtifact({
    schema: 'xo.domain-pack.v1' as const,
    packId: `pack.${namespace}`,
    namespace,
    version: '1.0.0',
    compatibility: { core: '1' },
    dependencies: [],
    publisher: { id: 'pub', name: 'Publisher' },
    contributions: { entityTypes: entityTypes.map((name) => ({ name })), predicates: [], relationshipTypes: [] },
  });

const VARIANTS: { label: string; install?: (server: TestServer, ws: string) => Promise<void> }[] = [
  { label: 'no pack' },
  {
    label: 'an unrelated pack',
    install: async (server, ws) =>
      assert.equal((await server.request('POST', `/workspaces/${ws}/knowledge/packs`, pack('astronomy', ['Star']))).status, 201),
  },
  {
    label: 'a pack for the flow’s own kinds',
    install: async (server, ws) =>
      assert.equal(
        (await server.request('POST', `/workspaces/${ws}/knowledge/packs`, pack('certificates', ['Client', 'Certificate']))).status,
        201,
      ),
  },
];

// A second row with a name already in the list: the same name on two rows, so neither gets a document.
const SAME_NAME = 'Asha Rao,asha2@client.example\n';

async function behaviour(variant: (typeof VARIANTS)[number]) {
  return withTempDir('xo-api-g3-', async (dataDir) =>
    withTempDir('xo-api-g3-files-', async (folderRoot) => {
      const box = newMailbox();
      const gm = await fakeGmail(box, {});
      const { server, ws, reviewer, base, cert, folder, connectionId, pairing } = await certificateWorkspace(
        dataDir,
        folderRoot,
        gm.baseUrl,
        {
          extraRows: SAME_NAME,
          ...(variant.install !== undefined ? { beforeCertify: variant.install } : {}),
        },
      );
      try {
        const items = { connectionId, proposalId: pairing.proposalId };
        const preview = (await server.request('POST', `${base}/previews`, { items, certificateId: cert.certificateId })).json<Preview>();
        const left = preview.itemsSource?.excludedRows ?? [];
        const approve = async (p: Preview) =>
          (await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer)).json<Preview>().approval!
            .approvalId;
        const approvalId = await approve(preview);
        // A recipient changed after approval: the start is refused and nothing is sent.
        await writeFile(
          join(folder, 'clients.csv'),
          `Client name,Email\n${CLIENTS.map((c) => `${c.name},${c.name === 'Bilal Khan' ? 'someone-else@client.example' : c.email}`).join('\n')}\nDev Patel,dev@client.example\n${SAME_NAME}`,
        );
        assert.equal((await server.request('POST', `/workspaces/${ws}/source-connections/${connectionId}/sync`, {})).status, 200);
        const changed = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, batchApprovalId: approvalId });
        const refusal = { status: changed.status, source: /source_changed/.test(changed.bodyText), sent: box.messages.length };
        return { counts: preview.counts, left, refusal, packs: variant.label };
      } finally {
        await server.stop();
        await gm.close();
      }
    }),
  );
}

async function unknownOutcome(variant: (typeof VARIANTS)[number]) {
  return withTempDir('xo-api-g3u-', async (dataDir) =>
    withTempDir('xo-api-g3u-files-', async (folderRoot) => {
      const box = newMailbox();
      // Every send is stored and then answered with a 500: the outcome of each call is unknown.
      const gm = await fakeGmail(box, { fail500AfterStoring: true });
      const { server, reviewer, base, cert, connectionId, pairing } = await certificateWorkspace(dataDir, folderRoot, gm.baseUrl, {
        ...(variant.install !== undefined ? { beforeCertify: variant.install } : {}),
      });
      try {
        const items = { connectionId, proposalId: pairing.proposalId };
        const p = (await server.request('POST', `${base}/previews`, { items, certificateId: cert.certificateId })).json<Preview>();
        const approvalId = (
          await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer)
        ).json<Preview>().approval!.approvalId;
        const started = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, batchApprovalId: approvalId });
        const perRecipient = CLIENTS.map((c) => box.messages.filter((m) => m.data.includes(c.email)).length);
        return { status: started.status, perRecipient };
      } finally {
        await server.stop();
        await gm.close();
      }
    }),
  );
}

test('G-3: the V1 flow’s safety behaviour is the same with no pack, an unrelated pack and its own pack', async () => {
  const seen = [];
  const outcomes = [];
  for (const v of VARIANTS) {
    seen.push(await behaviour(v));
    outcomes.push(await unknownOutcome(v));
  }
  const [none, ...others] = seen;
  // The safety behaviour itself, once: the same name on two rows leaves both out; the changed recipient stops the start; no message went out.
  assert.deepEqual(
    none!.left.map((r) => [r.row, r.reason]),
    [
      [1, 'name_on_several_rows'],
      [4, 'no_document'],
      [5, 'name_on_several_rows'],
    ],
  );
  assert.equal(none!.counts.sends, 2);
  assert.equal(none!.refusal.status, 409);
  assert.equal(none!.refusal.source, true);
  assert.equal(none!.refusal.sent, 0);
  // Identical in every variant.
  for (const o of others) assert.deepEqual({ ...o, packs: '' }, { ...none!, packs: '' }, `differs with ${o.packs}`);
  // An unknown outcome never resends: at most one message per recipient, whichever pack is installed.
  for (const o of outcomes)
    assert.ok(
      o.perRecipient.every((n) => n <= 1),
      JSON.stringify(o),
    );
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[2], outcomes[0]);
});
