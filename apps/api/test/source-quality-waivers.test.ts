/**
 * PX-2 — source quality is enforced at the approval itself: a capability read from a partial source cannot be approved
 * until a reviewer records a waiver bound to that source version and its findings. The findings are the server's reading;
 * the waiver is audited, append-only, and does not carry over to a new version of the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from './test-helpers.js';

const MIXED = fileURLToPath(new URL('./fixtures/mixed-partial.pdf', import.meta.url));
const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };

interface Quality {
  status: string;
  blockers: string[];
  assessment?: { sources: { digestSha256: string; state: string; findings: { key: string }[]; unwaived: { key: string }[] }[] };
}

test('partial source: approval refused with SOURCE_QUALITY_WAIVER_REQUIRED, a waiver is recorded, then the gate passes', async () => {
  await withTempDir('xo-api-waiver-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=mixed.pdf`, await readFile(MIXED))).json<{
        sourceId: string;
      }>();
      const rec = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{
        compilationId: string;
        status: string;
      }>();
      assert.equal(rec.status, 'succeeded');

      const q1 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/source-quality`)).json<Quality>();
      assert.equal(q1.status, 'blocked');
      const source = q1.assessment!.sources[0]!;
      assert.equal(source.state, 'partial');
      assert.deepEqual(
        source.findings.map((f) => f.key),
        ['page:2:unread'],
      );

      const caps = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/capabilities`)).json<{
        capabilities: { capabilityId: string }[];
      }>().capabilities;
      assert.ok(caps.length > 0, 'the readable pages produced capabilities');
      const approve = () =>
        server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/capabilities/${caps[0]!.capabilityId}/approve`);
      const refused = await approve();
      assert.equal(refused.status, 409, refused.bodyText);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'XO_SOURCE_QUALITY_WAIVER_REQUIRED');
      assert.match(refused.bodyText, /page 2 was not read/);

      // A reviewer cannot widen the findings, and must give a reason.
      const bad = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/waivers`, {
        digestSha256: source.digestSha256,
        reason: 'Accepting all of it.',
        findings: ['page:9:unread'],
      });
      assert.equal(bad.status, 400);
      const short = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/waivers`, {
        digestSha256: source.digestSha256,
        reason: 'ok',
      });
      assert.equal(short.status, 400);

      const waiver = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/waivers`, {
        digestSha256: source.digestSha256,
        reason: 'Page 2 is the scanned signature page; it states no rules.',
      });
      assert.equal(waiver.status, 201, waiver.bodyText);
      const w = waiver.json<{ waiverId: string; findings: string[]; actor: { id: string } }>();
      assert.deepEqual(w.findings, ['page:2:unread']);
      assert.equal(w.actor.id, 'test-identity', 'the waiver is attributed to the authenticated principal');

      const q2 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/source-quality`)).json<Quality>();
      assert.equal(q2.status, 'pass-with-waivers');
      const after = await approve();
      assert.notEqual(
        after.json<{ error?: { code: string } }>().error?.code,
        'XO_SOURCE_QUALITY_WAIVER_REQUIRED',
        'the quality gate no longer refuses',
      );

      // A new upload with different bytes is a new version: the waiver does not carry over.
      const changed = Buffer.concat([await readFile(MIXED), Buffer.from('\n%changed\n')]);
      const src2 = (await server.request('POST', `/workspaces/${ws}/sources?filename=mixed.pdf`, changed)).json<{ sourceId: string }>();
      const rec2 = (await server.request('POST', `/workspaces/${ws}/sources/${src2.sourceId}/compile`)).json<{ compilationId: string }>();
      const q3 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec2.compilationId}/source-quality`)).json<Quality>();
      assert.equal(q3.status, 'blocked');

      const listed = (await server.request('GET', `/workspaces/${ws}/waivers`)).json<{ waivers: { waiverId: string }[] }>().waivers;
      assert.deepEqual(
        listed.map((x) => x.waiverId),
        [w.waiverId],
      );
    } finally {
      await server.stop();
    }
  });
});

test('a trusted source needs no waiver, and waiving one is refused', async () => {
  await withTempDir('xo-api-waiver-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (
        await server.request('POST', `/workspaces/${ws}/sources?filename=n.md`, Buffer.from('# Notes\n\nSubmit the form to finance.\n'))
      ).json<{
        sourceId: string;
      }>();
      const rec = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>();
      const q = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/source-quality`)).json<Quality>();
      assert.equal(q.status, 'pass');
      const digest = q.assessment!.sources[0]!.digestSha256;
      const res = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/waivers`, {
        digestSha256: digest,
        reason: 'Nothing to waive here really.',
      });
      assert.equal(res.status, 400);
      assert.match(res.bodyText, /nothing to waive/);
    } finally {
      await server.stop();
    }
  });
});
