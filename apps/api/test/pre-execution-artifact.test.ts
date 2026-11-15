/**
 * PX-1 — the API keeps everything the compiler returned (the complete compilation artifact), names the source set it ran
 * on, lists source versions without merging uploads away, and agrees with the shared entry point the CLI uses: the same
 * bytes, name and configuration give the same artifact digest on both surfaces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileSourceSet, defaultCompileConfiguration, verifyCompilationArtifact, type CompilationArtifact } from '@xo/pre-execution';
import { TestServer, withTempDir } from './test-helpers.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };

test('the API persists and serves the complete, verified artifact; the record names the source set and digest', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const bytes = await readFile(`${ROOT}examples/vertical-test/burglary-policy.pdf`);
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=burglary-policy.pdf`, bytes)).json<{
        sourceId: string;
      }>();
      const compiled = await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`);
      assert.equal(compiled.status, 201, compiled.bodyText);
      const record = compiled.json<{ compilationId: string; sourceSetId: string; artifactDigest: string }>();
      assert.match(record.sourceSetId, /^ss_[0-9a-f]{24}$/);
      assert.match(record.artifactDigest, /^sha256:/);

      const res = await server.request('GET', `/workspaces/${ws}/compilations/${record.compilationId}/artifact`);
      assert.equal(res.status, 200, res.bodyText);
      const artifact = res.json<CompilationArtifact>();
      assert.equal(artifact.digest, record.artifactDigest);
      assert.deepEqual(verifyCompilationArtifact(artifact), { ok: true });
      for (const key of ['validation', 'diagnostics', 'passRuns', 'unclassified', 'reviewQueue', 'crossDocument', 'executionReadiness'])
        assert.ok(key in artifact, `artifact.${key} is served`);
      const source = (artifact.sources as { coverage?: { entries?: unknown[] }; parserVersion?: string }[])[0]!;
      assert.ok((source.coverage?.entries?.length ?? 0) > 0, 'per-page coverage reaches the API');
      assert.equal(source.parserVersion, 'pdf@uw-3c.1');

      // The same bytes, name and configuration through the shared entry point the CLI uses: the same artifact.
      const digest = createHash('sha256').update(bytes).digest('hex');
      const cli = await compileSourceSet(
        [
          {
            entry: {
              sourceId: 'file:burglary-policy.pdf',
              digestSha256: digest,
              name: 'burglary-policy.pdf',
              byteSize: bytes.length,
              role: 'primary',
            },
            input: { kind: 'pdf', bytes: new Uint8Array(bytes), sourcePath: 'burglary-policy.pdf' },
          },
        ],
        defaultCompileConfiguration({ ocr: { mode: 'off' } }),
      );
      assert.ok(cli.ok);
      assert.equal(cli.value.sourceSet.sourceSetId, record.sourceSetId, 'the upload record id is not part of the set identity');
      assert.equal(cli.value.artifact.digest, artifact.digest, 'API and CLI produce the identical artifact');
    } finally {
      await server.stop();
    }
  });
});

test('a tampered stored artifact is refused when served', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string; storageKeyPrefix: string }>();
      const src = (
        await server.request(
          'POST',
          `/workspaces/${ws.workspaceId}/sources?filename=n.md`,
          Buffer.from('# Notes\n\nSubmit the form to finance.\n'),
        )
      ).json<{ sourceId: string }>();
      const rec = (await server.request('POST', `/workspaces/${ws.workspaceId}/sources/${src.sourceId}/compile`)).json<{
        compilationId: string;
      }>();
      const { readdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      // Find the stored artifact on disk and change one field.
      const find = async (dir: string): Promise<string | undefined> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            const hit = await find(p);
            if (hit !== undefined) return hit;
          } else if (p.endsWith(`${rec.compilationId}/artifact.json`)) return p;
        }
        return undefined;
      };
      const path = await find(dataDir);
      assert.ok(path !== undefined, 'the artifact is stored next to the compilation');
      const stored = JSON.parse(await readFile(path, 'utf8')) as CompilationArtifact;
      await writeFile(path, JSON.stringify({ ...stored, valid: !stored.valid }));
      const res = await server.request('GET', `/workspaces/${ws.workspaceId}/compilations/${rec.compilationId}/artifact`);
      assert.equal(res.status, 404);
      assert.match(res.bodyText, /failed integrity check/);
    } finally {
      await server.stop();
    }
  });
});

test('source versions: two uploads of the same bytes are two records of one version; a content mismatch is refused with its code', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const body = Buffer.from('# Policy\n\nEmployees must give notice.\n');
      await server.request('POST', `/workspaces/${ws}/sources?filename=policy.md`, body);
      await server.request('POST', `/workspaces/${ws}/sources?filename=policy-copy.md`, body);
      await server.request('POST', `/workspaces/${ws}/sources?filename=other.md`, Buffer.from('# Other\n'));
      const versions = (await server.request('GET', `/workspaces/${ws}/source-versions`)).json<{
        versions: { digestSha256: string; records: { originalFilename: string }[] }[];
      }>().versions;
      assert.equal(versions.length, 2);
      const shared = versions.find((v) => v.records.length === 2)!;
      assert.deepEqual(shared.records.map((r) => r.originalFilename).sort(), ['policy-copy.md', 'policy.md']);
      assert.equal(shared.digestSha256, createHash('sha256').update(body).digest('hex'));

      const html = await server.request(
        'POST',
        `/workspaces/${ws}/sources?filename=report.pdf`,
        Buffer.from('<html><body>hi</body></html>'),
      );
      assert.equal(html.status, 400);
      assert.equal(
        html.json<{ error: { context: { sourceRejection: string } } }>().error.context.sourceRejection,
        'SOURCE_SIGNATURE_MISMATCH',
      );
    } finally {
      await server.stop();
    }
  });
});
