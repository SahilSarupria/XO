/**
 * RX-1d and RX-1e (ADR 0048), mandatory scenario 17: a readiness certificate pins the workspace's Domain Knowledge Packs; a pack added, removed or changed since makes
 * it stale, so the start is refused; the run manifest records the packs it ran with.
 */
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { makePackArtifact } from '@xo/knowledge-base';
import { packChanges } from '@xo/pre-execution';
import { env, items, type RunView } from './payments-fixture.js';

const manifest = (namespace: string, version = '1.0.0') => ({
  schema: 'xo.domain-pack.v1' as const,
  packId: `pack.${namespace}`,
  namespace,
  version,
  compatibility: { core: '1' },
  dependencies: [],
  publisher: { id: 'pub', name: 'Publisher' },
  contributions: { entityTypes: [{ name: 'Account' }], predicates: [], relationshipTypes: [] },
});

test('packChanges names each pack removed, changed or added', () => {
  const pin = (ns: string, version = '1.0.0', digest = `sha256:${ns}`) => ({ packId: `pack.${ns}`, namespace: ns, version, digest });
  assert.deepEqual(packChanges([pin('a'), pin('b')], [pin('a')]), ['the Domain Knowledge Pack pack.b 1.0.0 was removed']);
  assert.deepEqual(packChanges([pin('a')], [pin('a', '1.1.0', 'sha256:other')]), [
    'the Domain Knowledge Pack pack.a changed (1.0.0 → pack.a 1.1.0)',
  ]);
  assert.deepEqual(packChanges([pin('a')], [pin('a', '1.0.0', 'sha256:tampered')]), [
    'the Domain Knowledge Pack pack.a changed (1.0.0 → pack.a 1.0.0)',
  ]);
  assert.deepEqual(packChanges([], [pin('c')]), ['the Domain Knowledge Pack pack.c 1.0.0 was added']);
  assert.deepEqual(packChanges([pin('a')], [pin('a')]), []);
});

test('RX-1d: a pack installed after certification refuses the start; a new certificate pins it and the manifest records it', async () => {
  await env(async ({ server, pay, ws, defId, certId, data }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    assert.equal((await server.request('POST', `/workspaces/${ws}/knowledge/packs`, makePackArtifact(manifest('alpha')))).status, 201);
    const stale = await server.request('POST', runs, { input: { payment_items: items(1) }, certificateId: certId });
    assert.equal(stale.status, 409, stale.bodyText);
    assert.match(stale.bodyText, /stale: the Domain Knowledge Pack pack\.alpha 1\.0\.0 was added/);
    assert.equal(pay.calls.length, 0);

    const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${defId}/readiness`, {})).json<{
      certificateId: string;
      bindings: { packs: { packId: string; version: string; digest: string }[] };
    }>();
    assert.deepEqual(
      cert.bindings.packs.map((p) => [p.packId, p.version]),
      [['pack.alpha', '1.0.0']],
    );
    const started = await server.request('POST', runs, { input: { payment_items: items(1) }, certificateId: cert.certificateId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const runId = started.json<RunView>().runId;
    const m = (await server.request('GET', `${runs}/${runId}/manifest`)).json<{
      manifest: { packs: { packId: string; digest: string }[] };
    }>();
    assert.deepEqual(m.manifest.packs, cert.bindings.packs);

    // Scenario 17: replay rebuilds the run from its verified journal under the pinned definition and packs; nothing is sent.
    type Replay = { reproducible: boolean; reasons: string[]; replayed: { state: string; steps: { step: string; state: string }[] } };
    const before = pay.calls.length;
    const replay = (await server.request('GET', `${runs}/${runId}/replay`)).json<Replay>();
    assert.deepEqual([replay.reproducible, replay.reasons, replay.replayed.state], [true, [], started.json<RunView>().state]);
    const item = (started.json<RunView>().outputs as { items: { runId: string }[] }).items[0]!.runId;
    const itemReplay = (await server.request('GET', `${runs}/${item}/replay`)).json<Replay>();
    assert.equal(itemReplay.reproducible, true, 'an item is covered by its batch manifest');
    assert.ok(itemReplay.replayed.steps.length > 0);
    const why = (await server.request('GET', `${runs}/${item}/explain`)).json<{
      steps: { step: string }[];
      text: string;
      modelCalls: number;
    }>();
    assert.equal(why.modelCalls, 0);
    assert.ok(why.text.length > 0 && why.steps.length > 0);
    assert.equal(pay.calls.length, before, 'replay and explain send nothing');

    // A manifest altered on disk (here: a pinned pack swapped) is reported, and the replay is marked not reproducible.
    const file = join(data, ws, 'generated-runs', defId, 'manifests', `${runId}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as { manifest: { packs: { digest: string }[] } };
    stored.manifest.packs[0]!.digest = 'sha256:other';
    await writeFile(file, JSON.stringify(stored));
    const altered = (await server.request('GET', `${runs}/${runId}/replay`)).json<Replay>();
    assert.equal(altered.reproducible, false);
    assert.ok(altered.reasons.includes('the run manifest does not match its digest'), altered.reasons.join('; '));
    assert.ok(
      altered.reasons.some((r) => /pack\.alpha changed/.test(r)),
      altered.reasons.join('; '),
    );
    assert.equal((await server.request('GET', `${runs}/run_${'0'.repeat(32)}/replay`)).status, 404);
  });
});
