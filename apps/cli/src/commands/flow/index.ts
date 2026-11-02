import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DecisionTree } from '@xo/capability-layer';
import { parseTrees } from '@xo/capability-layer';
import { ConnectorHost, EnvVault, fileConnector, type Connector, type ConnectorPolicy } from '@xo/connectors';
import {
  DETERMINISTIC_HOST,
  determinismReport,
  loadWorkflowComponent,
  negotiateWorkflows,
  WorkflowLoadError,
  type WorkflowComponent,
} from '@xo/workflow-ir';
import { RunStore, WorkflowRunner, compareShadow } from '@xo/workflow-runtime';
import type { CommandRegistry } from '../../command-registry.js';

const SUBSYSTEM = 'flow';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const flag = (f: Readonly<Record<string, string | boolean>>, n: string): string | undefined =>
  typeof f[n] === 'string' ? (f[n] as string) : undefined;

function load(path: string, treesPath?: string): WorkflowComponent {
  const trees = treesPath !== undefined ? JSON.parse(readFileSync(resolve(treesPath), 'utf8')) : undefined;
  return loadWorkflowComponent(readFileSync(resolve(path)), trees !== undefined ? { decisionTrees: trees } : undefined).component;
}

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'Workflow IR: validate, report determinism, run durable workflows (backend only)');
  registry.register({
    name: 'flow',
    subsystem: SUBSYSTEM,
    usage:
      'xo flow validate <workflows.json> [--trees <decision_trees.json>]            Strict fail-closed validation (exit 3 on any error)\n' +
      'xo flow compare <workflows.json> --workflow <id> --runs <dir> --human <csv> --key <input> --field <result>   Shadow runs vs human decisions (run with --shadow first)\n' +
      'xo flow report <workflows.json>                                              Declared determinism class per step and workflow\n' +
      'xo flow run <workflows.json> --workflow <id> --input <json> --runs <dir>     Run durably; optional --policy <policy.json> --trees <file> --dry-run\n' +
      '                                       [--dedupe <key>]  (file connectors only; credentials come from XO_SECRET_* env; no model, no network)',
    run: async (args) => {
      const [sub, file] = args.positionals;
      if (file === undefined || sub === undefined) return fail('usage: xo flow <validate|report|run> <workflows.json>');
      try {
        const trees = flag(args.flags, 'trees');
        if (sub === 'validate') {
          const comp = load(file, trees);
          const n = negotiateWorkflows(comp, DETERMINISTIC_HOST);
          out(`OK · ${comp.workflows.length} workflow(s), ${comp.connectors.length} connector(s)`);
          for (const w of n.runnable)
            out(`  runnable on a deterministic-only host: ${w}${n.modelFree.includes(w) ? ' (no model needed)' : ''}`);
          for (const r of n.refused) out(`  needs more than a deterministic-only host: ${r.workflow}: ${r.reasons.join('; ')}`);
          return 0;
        }
        if (sub === 'report') {
          for (const wf of load(file, trees).workflows) {
            const r = determinismReport(wf);
            out(
              `${wf.id}@${wf.version}: ${r.counts.deterministic}/${wf.steps.length} deterministic by declaration (${r.counts.model_assisted} model-assisted, ${r.counts.human} human). Declared, not measured.`,
            );
            for (const s of r.steps.filter((x) => x.class !== 'deterministic'))
              out(
                `  ${s.step} [${s.class}] ${s.reason ?? ''}${s.bypassable === true ? ' (bypassed when structured input is complete)' : ''}`,
              );
          }
          return 0;
        }
        if (sub === 'run') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const inputRaw = flag(args.flags, 'input');
          if (id === undefined || runs === undefined || inputRaw === undefined) return fail('--workflow, --input and --runs are required');
          const comp = load(file, trees);
          const policyPath = flag(args.flags, 'policy');
          const policy: ConnectorPolicy & { fileRoots?: Record<string, Record<string, string>> } =
            policyPath !== undefined ? JSON.parse(readFileSync(resolve(policyPath), 'utf8')) : { connectors: {} };
          const implementations: Record<string, Connector> = {};
          for (const c of comp.connectors) {
            const roots = policy.fileRoots?.[c.id];
            if (c.kind === 'file' && roots !== undefined) implementations[c.id] = fileConnector({ roots, maxBytes: 1_048_576 });
          }
          const treeMap = new Map<string, DecisionTree>();
          if (trees !== undefined) for (const t of parseTrees(JSON.parse(readFileSync(resolve(trees), 'utf8'))) ?? []) treeMap.set(t.id, t);
          const runner = new WorkflowRunner({
            component: comp,
            workflowId: id,
            store: new RunStore(resolve(runs)),
            connectors: new ConnectorHost({ component: comp, policy, implementations, vault: new EnvVault() }),
            trees: treeMap,
            dryRun: args.flags['dry-run'] === true,
            shadow: args.flags['shadow'] === true,
          });
          const dedupe = flag(args.flags, 'dedupe');
          const r = await runner.start({ inputs: JSON.parse(inputRaw), ...(dedupe !== undefined ? { dedupeKey: dedupe } : {}) });
          out(JSON.stringify(r, null, 2));
          return r.state === 'completed' ? 0 : r.state === 'escalated' || r.state === 'waiting' ? 2 : 3;
        }
        if (sub === 'compare') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const human = flag(args.flags, 'human');
          const key = flag(args.flags, 'key');
          const field = flag(args.flags, 'field');
          if (id === undefined || runs === undefined || human === undefined || key === undefined || field === undefined)
            return fail('--workflow, --runs, --human <csv>, --key <input> and --field <result> are required');
          const wf = load(file, trees).workflows.find((w) => w.id === id);
          if (wf === undefined) return fail(`unknown workflow ${id}`);
          const rep = await compareShadow(new RunStore(resolve(runs)), wf, readFileSync(resolve(human), 'utf8'), {
            keyInput: key,
            resultField: field,
          });
          out(
            JSON.stringify(
              {
                ...rep,
                rows: undefined,
                note: 'agreement with the supplied human decisions on these cases only; not an accuracy claim about production',
              },
              null,
              2,
            ),
          );
          return rep.disagree === 0 ? 0 : 2;
        }
        return fail(`unknown subcommand "${sub}"`);
      } catch (e) {
        if (e instanceof WorkflowLoadError) {
          process.stderr.write(
            `REFUSED:\n${e.issues
              .filter((i) => i.severity === 'error')
              .map((i) => `  ${i.code} ${i.path}: ${i.message}`)
              .join('\n')}\n`,
          );
          return 3;
        }
        return fail((e as Error).message);
      }
    },
  });
}
