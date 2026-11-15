/**
 * PX-8 (gap PX-G27) — cross-surface conformance: the same sources and goal give the same pre-execution results through the
 * API (upload → compile → generate → certify) and the CLI (`xo generate-workflow --certify`). Every digest that does not
 * depend on a workspace's own decisions must be identical: source set, compilation artifact, compiled graph, goal, each
 * step's contract, the Workflow IR definition and its digest. (Approval is a workspace decision, so the inventory digest
 * and the authorization gate legitimately differ: the CLI has no approvals.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from '../../api/test/test-helpers.js';
import { generateWorkflowCommand } from '../src/commands/compiler/generate-workflow.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const corpus = (name: string): string => fileURLToPath(new URL(`../../../examples/structure-corpus/${name}`, import.meta.url));

const INLINE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

const FIXTURES: readonly { name: string; read: () => Promise<Buffer>; goal: { text: string; needs?: string[] } }[] = [
  { name: 'ops.md', read: async () => Buffer.from(INLINE), goal: { text: 'Ship a release', needs: ['Run the full test suite'] } },
  { name: 'refunds.md', read: async () => Buffer.from(INLINE), goal: { text: 'Decide a refund' } },
  { name: 'release.md', read: () => readFile(corpus('release.md')), goal: { text: 'Release the software' } },
  { name: 'onboarding.md', read: () => readFile(corpus('onboarding.md')), goal: { text: 'Onboard a new hire before day one' } },
];

interface Bindings {
  sourceSetDigest: string;
  artifactDigest: string;
  xoirGraphHash: string;
  goalDigest: string;
  contractHashes: Record<string, string>;
  workflowDefinitionDigest: string;
}

for (const fx of FIXTURES) {
  test(`conformance: ${fx.name} — the API and the CLI agree on every decision-independent digest`, async () => {
    const bytes = await fx.read();
    const dir = await mkdtemp(join(tmpdir(), 'xo-conf-'));
    const file = join(dir, fx.name);
    await writeFile(file, bytes);

    // The CLI records a source under the path it was given, as the API records it under the uploaded file name: run it
    // from the file's folder so both name the source the same (the name is part of the source set's identity).
    const cwd = process.cwd();
    process.chdir(dir);
    let cli: Awaited<ReturnType<typeof generateWorkflowCommand>>;
    try {
      cli = await generateWorkflowCommand({
        sources: [fx.name],
        goal: fx.goal.text,
        ...(fx.goal.needs !== undefined ? { needs: fx.goal.needs } : {}),
        certify: true,
        json: true,
      });
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.exitCode, 0, cli.lines.join('\n'));
    const local = JSON.parse(cli.lines.join('\n')) as {
      lowered: { definitionDigest: string; component: unknown };
      certificate: { bindings: Bindings };
    };

    await withTempDir('xo-conf-api-', async (dataDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=${encodeURIComponent(basename(file))}`, bytes)).json<{
          sourceId: string;
        }>();
        const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
          .compilationId;
        const gen = await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal: fx.goal });
        assert.equal(gen.status, 201, gen.bodyText);
        const def = gen.json<{ definition: { definitionId: string; lowered: { definitionDigest: string; component: unknown } } }>()
          .definition;
        const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
          bindings: Bindings;
        }>();

        assert.deepEqual(def.lowered.component, local.lowered.component, 'the same Workflow IR');
        assert.equal(def.lowered.definitionDigest, local.lowered.definitionDigest, 'the same Workflow IR digest');
        assert.deepEqual(def.lowered.component, local.lowered.component, 'the same Workflow IR');
        for (const k of ['sourceSetDigest', 'artifactDigest', 'xoirGraphHash', 'goalDigest', 'workflowDefinitionDigest'] as const)
          assert.equal(cert.bindings[k], local.certificate.bindings[k], k);
        assert.deepEqual(cert.bindings.contractHashes, local.certificate.bindings.contractHashes, 'the same step contracts');
      } finally {
        await server.stop();
      }
    });
  });
}
