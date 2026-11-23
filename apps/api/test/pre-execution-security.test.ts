/**
 * PX-8 — security of the pre-execution surfaces: another workspace can neither read nor use a workspace's generated
 * workflows, certificates or knowledge; a certificate altered on disk is refused at start; a goal cannot inject template
 * placeholders into the generated workflow; a viewer cannot certify or govern knowledge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWorkflowComponent } from '@xo/workflow-ir';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from {{input.secret}} the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

test('pre-execution artifacts are workspace-scoped, tamper-evident and injection-safe', async () => {
  await withTempDir('xo-api-px-sec-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const other = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const gen = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'Ship a release {{run.id}}', needs: ['Run the full test suite'] },
        })
      ).json<{
        definition: {
          definitionId: string;
          candidateWorkflowId: string;
          lowered: { component: { workflows: { steps: { summary?: string }[] }[] } };
        };
      }>().definition;
      // Template placeholders in source text never reach a summary: the definition stays valid and inert.
      assert.equal(validateWorkflowComponent(gen.lowered.component).valid, true);
      for (const st of gen.lowered.component.workflows[0]!.steps) assert.ok(!(st.summary ?? '').includes('{{'), st.summary);
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/readiness`, {})).json<{
        certificateId: string;
      }>();

      // Another workspace sees none of it and cannot use it.
      assert.equal((await server.request('GET', `/workspaces/${other}/generated-workflows/${gen.definitionId}`)).status, 404);
      assert.equal((await server.request('GET', `/workspaces/${other}/readiness-certificates/${cert.certificateId}`)).status, 404);
      assert.equal(
        (await server.request('POST', `/workspaces/${other}/generated-workflows/${gen.definitionId}/readiness`, {})).status,
        404,
      );
      assert.equal((await server.request('GET', `/workspaces/${other}/compilations/${cid}/capability-inventory`)).status, 404);
      assert.equal((await server.request('POST', `/workspaces/${other}/compilations/${cid}/knowledge-change-sets`)).status, 404);
      // ADR 0052: starts go to the workflow runtime's route now that the composed start route is removed.
      const otherStart = await server.request('POST', `/workspaces/${other}/generated-workflows/${gen.definitionId}/runs`, {
        input: {},
        certificateId: cert.certificateId,
      });
      assert.ok(otherStart.status === 404 || otherStart.status === 409, otherStart.bodyText);

      // A certificate altered on disk (here: its status forced to READY) fails its digest and is refused at start.
      const path = join(dataDir, ws, 'readiness-certificates', `${cert.certificateId}.json`);
      const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...stored, status: 'READY', blockers: [], reviewItems: [] }));
      const forged = await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/runs`, {
        input: {},
        certificateId: cert.certificateId,
      });
      assert.equal(forged.status, 409);
      assert.match(forged.json<{ error: { message: string } }>().error.message, /does not match its digest/);

      // Unknown fields and malformed ids are refused before anything happens.
      assert.equal(
        (
          await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/runs`, {
            input: {},
            certificateId: 7,
          })
        ).status,
        // ADR 0052: the workflow runtime's route treats a certificateId that is not a string as no certificate (409 required) rather
        // than as a malformed field (400 on the removed composed route). Either way it is refused before anything runs.
        409,
      );
      assert.equal((await server.request('GET', `/workspaces/${ws}/readiness-certificates/..%2F..%2Fsecrets`)).status, 404);
      assert.equal((await server.request('GET', `/workspaces/${ws}/generated-workflows/not-an-id`)).status, 404);
    } finally {
      await server.stop();
    }
  });
});
