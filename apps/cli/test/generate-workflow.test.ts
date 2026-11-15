import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkflowComponent } from '@xo/workflow-ir';
import { generateWorkflowCommand } from '../src/commands/compiler/generate-workflow.js';
import { selectWorkflow } from '../src/commands/runtime/workflow-pipeline.js';

const DOC =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code. | Main is checked out. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

test('xo generate-workflow: the goal chooses, the Workflow IR is valid, the digest repeats; no match lists the choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-cli-gwf-'));
  const src = join(dir, 'ops.md');
  await writeFile(src, DOC);
  const out = join(dir, 'workflows.json');
  const a = await generateWorkflowCommand({ sources: [src], goal: 'ship a release', needs: ['Run the full test suite'], out, json: true });
  assert.equal(a.exitCode, 0, a.lines.join('\n'));
  const parsed = JSON.parse(a.lines.join('\n')) as { lowered: { definitionDigest: string; complete: boolean } };
  assert.equal(parsed.lowered.complete, true);
  assert.equal(validateWorkflowComponent(JSON.parse(await readFile(out, 'utf8'))).valid, true);
  const b = JSON.parse(
    (await generateWorkflowCommand({ sources: [src], goal: 'ship a release', needs: ['Run the full test suite'], json: true })).lines.join(
      '\n',
    ),
  ) as typeof parsed;
  assert.equal(b.lowered.definitionDigest, parsed.lowered.definitionDigest);
  const none = await generateWorkflowCommand({ sources: [src], goal: 'plan the picnic' });
  assert.equal(none.exitCode, 1);
  assert.ok(none.lines.some((l) => l.includes('--workflow-id')));
});

test('xo workflow --goal selects by purpose, and says so when no goal is given', () => {
  const w = (id: string, names: string[]) =>
    ({
      id,
      name: names.join(' → '),
      description: '',
      steps: names.map((n, i) => ({ capabilityName: n, order: i })),
      confidence: 0.8,
    }) as never;
  const flows = [w('a', ['Pull code', 'Run tests', 'Publish']), w('b', ['Evaluate refund'])];
  assert.equal(selectWorkflow(flows, { source: 'x', goal: 'evaluate a refund' }).workflow?.id, 'b');
  assert.match(selectWorkflow(flows, { source: 'x' }).rationale, /no goal given/);
});
