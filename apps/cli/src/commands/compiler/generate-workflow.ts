/**
 * PX-6 — `xo generate-workflow`: sources + a goal → Workflow IR, through the same `@xo/pre-execution` functions the API
 * uses (scope selection, capability inventory, lowering), so the same sources and goal give the same definition digest.
 */
import { writeFile } from 'node:fs/promises';
import { composeWorkflows } from '@xo/workflow-composer';
import {
  buildCapabilityInventory,
  compileSourceSet,
  defaultCompileConfiguration,
  goalSpecification,
  lowerCandidateWorkflow,
  selectWorkflowScope,
  type SourceSetMember,
} from '@xo/pre-execution';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { collectSources } from './source-collection.js';

export interface GenerateWorkflowOptions {
  readonly sources: readonly string[];
  readonly goal: string;
  readonly needs?: readonly string[];
  readonly section?: string;
  readonly workflowId?: string;
  /** Write the Workflow IR component (`workflows/workflows.json` shape) here. */
  readonly out?: string;
  readonly json?: boolean;
}

export const GENERATE_WORKFLOW_USAGE =
  'xo generate-workflow <source>... --goal <text> [--need <step>]... [--section <heading>] [--workflow-id <id>] [--out <workflows.json>] [--json]';

export async function generateWorkflowCommand(o: GenerateWorkflowOptions): Promise<CommandResult> {
  if (o.sources.length === 0) return failWith(GENERATE_WORKFLOW_USAGE);
  let goal;
  try {
    goal = goalSpecification({
      text: o.goal,
      ...(o.needs !== undefined ? { needs: o.needs } : {}),
      ...(o.section !== undefined ? { section: o.section } : {}),
    });
  } catch (cause) {
    return failWith((cause as Error).message);
  }
  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected = await collectSources(o.sources);
  } catch (cause) {
    return failWith(`could not read source(s): ${(cause as Error).message}`);
  }
  try {
    const members: SourceSetMember[] = collected.inputs.map((input, i) => ({ entry: collected.entries[i]!, input }) as SourceSetMember);
    const compiled = await compileSourceSet(members, defaultCompileConfiguration({}));
    if (!compiled.ok) return failWith(`[${compiled.error.code}] ${compiled.error.message}`);
    const { result, artifact } = compiled.value;
    const composed = composeWorkflows(result.graph, { now: () => '1970-01-01T00:00:00.000Z' });
    if (!composed.ok) return failWith(`[${composed.error.code}] ${composed.error.message}`);
    const inventory = buildCapabilityInventory(result.graph, { artifactDigest: artifact.digest, needs: goal.needs ?? [] });

    let candidateId = o.workflowId;
    let rationale = `named explicitly (--workflow-id ${o.workflowId})`;
    if (candidateId === undefined) {
      const scope = selectWorkflowScope(composed.value, goal);
      if (scope.status === 'needs_clarification')
        return { exitCode: 1, lines: [scope.question, ...scope.options.map((x) => `  --workflow-id ${x.workflowId}   ${x.name}`)] };
      if (scope.status === 'no_match')
        return { exitCode: 1, lines: [scope.reason, ...composed.value.map((w) => `  --workflow-id ${w.id}   ${w.name}`)] };
      candidateId = scope.workflowId;
      rationale = scope.rationale;
    }
    const candidate = composed.value.find((w) => w.id === candidateId);
    if (candidate === undefined) return failWith(`no workflow "${candidateId}" in these sources`);
    const lowered = lowerCandidateWorkflow(result.graph, candidate, inventory);
    if (o.out !== undefined && lowered.component !== undefined) await writeFile(o.out, `${JSON.stringify(lowered.component, null, 2)}\n`);
    if (o.json === true)
      return ok([
        JSON.stringify(
          { goal, selection: rationale, candidateWorkflowId: candidate.id, inventoryDigest: inventory.digest, lowered },
          null,
          2,
        ),
      ]);
    const lines = [
      `Workflow:           ${candidate.name}`,
      `Selected because:   ${rationale}`,
      `Definition digest:  ${lowered.definitionDigest}`,
      `Complete:           ${lowered.complete ? 'yes' : 'no'}`,
      ...lowered.rationale.map((r) => `  ${r.stepId.padEnd(28)} ${r.construct.padEnd(8)} ${r.reason}`),
      ...lowered.issues.map((i) => `  [${i.severity}] ${i.code}: ${i.message}`),
      ...(o.out !== undefined && lowered.component !== undefined ? [`Written:            ${o.out}`] : []),
    ];
    return { exitCode: lowered.complete ? 0 : 1, lines };
  } finally {
    await collected.cleanup();
  }
}
