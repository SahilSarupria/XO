import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBundle } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { summarizeBenchmarks } from '../src/library/package-meta.js';

const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

async function withWs<T>(fn: (c: { server: TestServer; base: string }) => Promise<T>): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', { name: 'Lib' })).json<{ workspaceId: string }>().workspaceId;
        return await fn({ server, base: `/workspaces/${ws}` });
      } finally {
        await server.stop();
      }
    }),
  );
}

async function publish(server: TestServer, base: string, name: string, headers: Record<string, string> = {}) {
  const bundle = buildFixtureBundle({ name });
  const res = await server.request('POST', `${base}/registry/packages`, Buffer.from(await packBundle(bundle)), headers);
  assert.equal(res.status, 201, res.bodyText);
  return res.json<{ id: string }>().id;
}

interface Item {
  id: string;
  name: string;
  installed: boolean;
  madeByMe: boolean;
  trust: { signed: boolean; benchmarked: boolean; overallScore: number | null; independentlyVerified: boolean };
}

test('library lists everything in the workspace registry (no search term needed) and filters by scope and query', async () => {
  await withWs(async ({ server, base }) => {
    const other = await server.issueAdditionalIdentity('pub2');
    await server.request('POST', `${base}/members`, { identityId: 'pub2', role: 'publisher' });
    const a = await publish(server, base, 'alpha_policy');
    const b = await publish(server, base, 'beta_rules', as(other));

    const all = (await server.request('GET', `${base}/library`)).json<{ items: Item[]; counts: Record<string, number>; catalog: string }>();
    assert.equal(all.catalog, 'workspace');
    assert.deepEqual(all.items.map((i) => i.id).sort(), [a, b].sort());
    assert.deepEqual(all.counts, { all: 2, installed: 0, mine: 1 });

    const mine = (await server.request('GET', `${base}/library?scope=mine`)).json<{ items: Item[] }>();
    assert.deepEqual(
      mine.items.map((i) => i.id),
      [a],
    );
    const mineOther = (await server.request('GET', `${base}/library?scope=mine`, undefined, as(other))).json<{ items: Item[] }>();
    assert.deepEqual(
      mineOther.items.map((i) => i.id),
      [b],
    );

    const q = (await server.request('GET', `${base}/library?q=beta`)).json<{ items: Item[] }>();
    assert.deepEqual(
      q.items.map((i) => i.name),
      ['beta_rules'],
    );
    assert.equal((await server.request('GET', `${base}/library?scope=weird`)).status, 400);
  });
});

test('trust block reports only what records say: unsigned, no benchmarks, never independently verified', async () => {
  await withWs(async ({ server, base }) => {
    const id = await publish(server, base, 'gamma');
    let item = (await server.request('GET', `${base}/library`)).json<{ items: Item[] }>().items[0]!;
    assert.deepEqual(item.trust, {
      signed: false,
      signerCount: 0,
      signaturesVerified: false,
      benchmarked: false,
      overallScore: null,
      independentlyVerified: false,
    });

    for (const [category, score] of [
      ['knowledge', 90],
      ['safety', 96],
      ['knowledge', 94],
    ] as const) {
      assert.equal(
        (await server.request('POST', `${base}/registry/packages/${encodeURIComponent(id)}/benchmarks`, { category, score })).status,
        201,
      );
    }
    item = (await server.request('GET', `${base}/library`)).json<{ items: Item[] }>().items[0]!;
    assert.equal(item.trust.benchmarked, true);
    assert.equal(item.trust.overallScore, 95, 'mean of the latest score per category: (94 + 96) / 2');
    assert.equal(item.trust.independentlyVerified, false);

    const detail = (await server.request('GET', `${base}/library/packages/${encodeURIComponent(id)}`)).json<Record<string, any>>();
    assert.deepEqual(detail['benchmarks'].byCategory, { knowledge: 94, safety: 96 });
    assert.equal(detail['benchmarks'].runs, 3);
    assert.equal(detail['installable'], true);
    assert.ok(detail['components'].some((c: { kind: string }) => c.kind === 'safety_rules'));
    assert.equal((await server.request('GET', `${base}/library/packages/sha256%3Anope`)).status, 404);
  });
});

test('install from the registry, appears as installed, can be uninstalled; duplicate install is refused', async () => {
  await withWs(async ({ server, base }) => {
    const id = await publish(server, base, 'delta');
    const first = await server.request('POST', `${base}/library/installs`, { packageId: id });
    assert.equal(first.status, 201, first.bodyText);

    const lib = (await server.request('GET', `${base}/library?scope=installed`)).json<{ items: Item[] }>();
    assert.deepEqual(
      lib.items.map((i) => i.name),
      ['delta'],
    );
    assert.equal((await server.request('GET', `${base}/library/installs`)).json<{ installs: unknown[] }>().installs.length, 1);

    const dup = await server.request('POST', `${base}/library/installs`, { packageId: id });
    assert.ok(dup.status === 409 || dup.status === 422, `duplicate install must be refused, got ${dup.status}`);

    const runtime = (await server.request('GET', `${base}/runtime/status`)).json<{ runtime: { mountedPackages: number } }>();
    assert.equal(runtime.runtime.mountedPackages, 1, 'the installed XO is really mounted by the workspace runtime');

    assert.equal((await server.request('DELETE', `${base}/library/installs/delta/1.0.0`)).status, 200);
    assert.equal((await server.request('GET', `${base}/library?scope=installed`)).json<{ items: unknown[] }>().items.length, 0);
    assert.equal((await server.request('DELETE', `${base}/library/installs/delta/1.0.0`)).status, 404);

    const events = (await server.request('GET', `${base}/audit/events`)).json<{ events: { event: string }[] }>().events.map((e) => e.event);
    assert.ok(events.includes('xo.installed') && events.includes('xo.uninstalled') && events.includes('xo.published'));
  });
});

test('install input validation, trust enforcement and permissions', async () => {
  await withWs(async ({ server, base }) => {
    const id = await publish(server, base, 'epsilon');
    assert.equal((await server.request('POST', `${base}/library/installs`, {})).status, 400);
    assert.equal((await server.request('POST', `${base}/library/installs`, { packageId: 'sha256:missing' })).status, 404);

    const viewer = await server.issueAdditionalIdentity('v');
    await server.request('POST', `${base}/members`, { identityId: 'v', role: 'viewer' });
    assert.equal((await server.request('POST', `${base}/library/installs`, { packageId: id }, as(viewer))).status, 403);
    assert.equal((await server.request('GET', `${base}/library`, undefined, as(viewer))).status, 200, 'viewers can browse');

    await server.request('PUT', `${base}/settings`, { trust: { requireSignedPackages: true } });
    const refused = await server.request('POST', `${base}/library/installs`, { packageId: id });
    assert.equal(refused.status, 412);
    assert.match(refused.bodyText, /signed packages/);
  });
});

test('a package whose archive was not retained cannot be installed, and the refusal says why', async () => {
  await withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const id = await publish(server, base, 'zeta');
        const { readdir, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const dir = join(dataDir, ws, 'archives');
        const files = await readdir(dir);
        assert.equal(files.length, 1, 'publish retained exactly one archive');
        await rm(join(dir, files[0]!));

        const detail = (await server.request('GET', `${base}/library/packages/${encodeURIComponent(id)}`)).json<{ installable: boolean }>();
        assert.equal(detail.installable, false);
        const res = await server.request('POST', `${base}/library/installs`, { packageId: id });
        assert.equal(res.status, 412);
        assert.match(res.bodyText, /archive was not retained/);
      } finally {
        await server.stop();
      }
    }),
  );
});

test('summarizeBenchmarks: latest per category, mean of those, empty is null', () => {
  assert.equal(summarizeBenchmarks([]).overall, null);
  const s = summarizeBenchmarks([
    { id: '1', packageId: 'p', category: 'a', score: 80, runAt: '2026-01-01T00:00:00Z', challengeable: true },
    { id: '2', packageId: 'p', category: 'a', score: 90, runAt: '2026-02-01T00:00:00Z', challengeable: true },
    { id: '3', packageId: 'p', category: 'b', score: 70, runAt: '2026-01-15T00:00:00Z', challengeable: true },
  ] as never);
  assert.deepEqual(s.byCategory, { a: 90, b: 70 });
  assert.equal(s.overall, 80);
  assert.equal(s.lastRunAt, '2026-02-01T00:00:00Z');
});
