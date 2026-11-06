import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DecisionTree } from '@xo/capability-layer';
import { parseTrees } from '@xo/capability-layer';
import { ConnectorHost, EnvVault, type ConnectorPolicy } from '@xo/connectors';
import {
  DETERMINISTIC_HOST,
  determinismReport,
  linkWorkflowComponents,
  loadWorkflowComponent,
  negotiateWorkflows,
  WorkflowLoadError,
  type WorkflowComponent,
} from '@xo/workflow-ir';
import {
  LeaseAuthority,
  LeasedRunStore,
  LedgerReplica,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  compareShadow,
  buildAuditBundle,
  explainRun,
  renderExplanation,
  verifyAuditBundle,
  type AuditBundle,
  type Reviewer,
} from '@xo/workflow-runtime';
import { createXoServer } from '@xo/server';
import { join } from 'node:path';
import type { CommandRegistry } from '../../command-registry.js';
import { buildImplementations, type OperatorPolicyFile } from './bindings.js';
import { capsFromFlags, extractorFor } from './extractor.js';

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
      'xo flow explain <workflows.json> --workflow <id> --runs <dir> --run <runId> [--json]   Why a run did what it did, from its verified journal\n' +
      'xo flow audit-export <workflows.json> --workflow <id> --runs <dir> --run-ids a,b --key <pem> --out <file> [--policy p.json] [--signer name]   Signed audit bundle\n' +
      'xo flow audit-verify <bundle.json> --pubkey <pem>   Verify signature, merkle root, hash chains\n' +
      'xo flow link <a.json> <b.json> [...] [--names a,b] [--order a,b] [--out merged.json]   Load several XOs together; overlaps and conflicts reported, unresolved ones blocked (exit 2)\n' +
      'xo flow report <workflows.json>                                              Declared determinism class per step and workflow\n' +
      'xo flow run <workflows.json> [--memo-dir <dir>] --workflow <id> --input <json> --runs <dir>     Run durably; optional --policy <policy.json> --trees <file> --dry-run\n' +
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
          const policy: OperatorPolicyFile =
            policyPath !== undefined ? JSON.parse(readFileSync(resolve(policyPath), 'utf8')) : { connectors: {} };
          const bound = await buildImplementations(comp, policy);
          if (!bound.ok) return fail(bound.error);
          const implementations = bound.value;
          const treeMap = new Map<string, DecisionTree>();
          if (trees !== undefined) for (const t of parseTrees(JSON.parse(readFileSync(resolve(trees), 'utf8'))) ?? []) treeMap.set(t.id, t);
          const ex = extractorFor(comp, id);
          if (!ex.ok) return fail(ex.error);
          const memoDir = flag(args.flags, 'memo-dir');
          const caps = capsFromFlags(args.flags, resolve(runs));
          if (!caps.ok) return fail(caps.error);
          const runner = new WorkflowRunner({
            component: comp,
            workflowId: id,
            store: new RunStore(resolve(runs)),
            connectors: new ConnectorHost({ component: comp, policy, implementations, vault: new EnvVault() }),
            trees: treeMap,
            ...(ex.value !== undefined ? { extractor: ex.value } : {}),
            ...(memoDir !== undefined ? { memoDir: resolve(memoDir) } : {}),
            ...(caps.value !== undefined ? { caps: caps.value } : {}),
            dryRun: args.flags['dry-run'] === true,
            shadow: args.flags['shadow'] === true,
          });
          const dedupe = flag(args.flags, 'dedupe');
          const r = await runner.start({ inputs: JSON.parse(inputRaw), ...(dedupe !== undefined ? { dedupeKey: dedupe } : {}) });
          out(JSON.stringify(r, null, 2));
          return r.state === 'completed' ? 0 : r.state === 'escalated' || r.state === 'waiting' ? 2 : 3;
        }
        if (sub === 'explain') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const runId = flag(args.flags, 'run');
          if (id === undefined || runs === undefined || runId === undefined)
            return fail('--workflow, --runs and --run <run id> are required');
          const wf = load(file, trees).workflows.find((w) => w.id === id);
          if (wf === undefined) return fail(`unknown workflow ${id}`);
          const x = await explainRun(new RunStore(resolve(runs)), wf, runId);
          out(args.flags['json'] === true ? JSON.stringify(x, null, 2) : renderExplanation(x));
          return 0;
        }
        if (sub === 'audit-export') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const ids = flag(args.flags, 'run-ids');
          const keyFile = flag(args.flags, 'key');
          const outFile = flag(args.flags, 'out');
          if (id === undefined || runs === undefined || ids === undefined || keyFile === undefined || outFile === undefined)
            return fail('--workflow, --runs, --run-ids a,b, --key <ed25519 private pem>, --out <file> are required');
          const bytes = readFileSync(resolve(file));
          const wf = load(file, trees).workflows.find((w) => w.id === id);
          if (wf === undefined) return fail(`unknown workflow ${id}`);
          const grantsPath = flag(args.flags, 'policy');
          const grants: Record<string, string[]> = {};
          if (grantsPath !== undefined)
            for (const [c, v] of Object.entries((JSON.parse(readFileSync(resolve(grantsPath), 'utf8')) as ConnectorPolicy).connectors))
              grants[c] = [...v.grant];
          const bundle = await buildAuditBundle({
            store: new RunStore(resolve(runs)),
            runIds: ids.split(',').map((x) => x.trim()),
            workflow: { id: wf.id, version: wf.version },
            componentBytes: bytes,
            connectorGrants: grants,
            signer: flag(args.flags, 'signer') ?? 'unknown',
            privateKeyPem: readFileSync(resolve(keyFile), 'utf8'),
          });
          writeFileSync(resolve(outFile), `${JSON.stringify(bundle, null, 2)}\n`);
          out(`wrote ${outFile}: ${bundle.runs.length} run(s), merkle root ${bundle.merkleRoot}`);
          return 0;
        }
        if (sub === 'audit-verify') {
          const pub = flag(args.flags, 'pubkey');
          if (pub === undefined) return fail('--pubkey <ed25519 public pem> is required');
          const v = verifyAuditBundle(JSON.parse(readFileSync(resolve(file), 'utf8')) as AuditBundle, readFileSync(resolve(pub), 'utf8'));
          out(v.ok ? 'VERIFIED: signature, merkle root and every hash chain check out' : `FAILED:\n  ${v.problems.join('\n  ')}`);
          return v.ok ? 0 : 3;
        }
        if (sub === 'link') {
          const files = args.positionals.slice(1);
          const names = (flag(args.flags, 'names') ?? '').split(',').filter((x) => x !== '');
          if (files.length < 2) return fail('usage: xo flow link <a.json> <b.json> [...] [--names a,b] [--order a,b] [--out merged.json]');
          const order = (flag(args.flags, 'order') ?? '').split(',').filter((x) => x !== '');
          const inputs = files.map((f, i) => ({ xo: names[i] ?? f, component: load(f) }));
          const r = linkWorkflowComponents(inputs, { order });
          if (flag(args.flags, 'out') !== undefined && !r.hasUnresolved)
            writeFileSync(resolve(flag(args.flags, 'out') as string), `${JSON.stringify(r.component, null, 2)}\n`);
          out(
            JSON.stringify(
              {
                workflows: r.component.workflows.map((w) => w.id),
                overlaps: r.overlaps,
                conflicts: r.conflicts,
                blocked: r.blocked,
                unresolved: r.hasUnresolved,
              },
              null,
              2,
            ),
          );
          return r.hasUnresolved ? 2 : 0;
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

  registry.register({
    name: 'serve',
    subsystem: SUBSYSTEM,
    usage:
      'xo serve --workflows <workflows.json> --runs <dir> [--policy <policy.json>] [--trees <file>] [--approvers <reviewers.json>] [--port 7433] [--host 127.0.0.1] [--allow-remote]\n' +
      '                        Local HTTP API (runs, approvals, leases, ledger sync, loader resolve). The bearer token is read from XO_SERVER_TOKEN (>= 24 chars), never from a flag.\n' +
      '                        Free-text workflows use the operator model (XO_PROVIDER/XO_MODEL/<vendor>_API_KEY, optional XO_EXTRACTOR_*); workflows that need none never read it. [--memo-dir <dir>] reuses validated facts for identical cases. [--daily-model-calls <n>] [--daily-effects <n>] persisted daily caps (exceeding one escalates, never drops).\n' +
      '                        Binds to loopback by default. There is no TLS: use a TLS proxy for anything but localhost.',
    run: async (args) => {
      const token = process.env['XO_SERVER_TOKEN'];
      if (token === undefined || token.length < 24) return fail('set XO_SERVER_TOKEN to a secret of at least 24 characters');
      const file = flag(args.flags, 'workflows');
      const runs = flag(args.flags, 'runs');
      if (file === undefined || runs === undefined) return fail('--workflows and --runs are required');
      try {
        const trees = flag(args.flags, 'trees');
        const comp = load(file, trees);
        const policyPath = flag(args.flags, 'policy');
        const policy: OperatorPolicyFile =
          policyPath !== undefined ? JSON.parse(readFileSync(resolve(policyPath), 'utf8')) : { connectors: {} };
        const bound = await buildImplementations(comp, policy);
        if (!bound.ok) return fail(bound.error);
        const implementations = bound.value;
        const treeMap = new Map<string, DecisionTree>();
        if (trees !== undefined) for (const t of parseTrees(JSON.parse(readFileSync(resolve(trees), 'utf8'))) ?? []) treeMap.set(t.id, t);
        const memoDir = flag(args.flags, 'memo-dir');
        const caps = capsFromFlags(args.flags, resolve(runs));
        if (!caps.ok) return fail(caps.error);
        const approvers = flag(args.flags, 'approvers');
        const reviewers: Reviewer[] = approvers !== undefined ? JSON.parse(readFileSync(resolve(approvers), 'utf8')) : [];
        const base = resolve(runs);
        const store = new RunStore(join(base, 'journal'));
        const authority = new LeaseAuthority(join(base, 'leases'), store);
        const replica = new LedgerReplica(join(base, 'forks'), store);
        const leased = new LeasedRunStore(authority, store);
        const connectors = new ConnectorHost({ component: comp, policy, implementations, vault: new EnvVault() });
        const runners: Record<string, WorkflowRunner> = {};
        const skipped: string[] = [];
        for (const wf of comp.workflows) {
          try {
            const ex = extractorFor(comp, wf.id);
            if (!ex.ok) throw new Error(ex.error);
            runners[wf.id] = new WorkflowRunner({
              component: comp,
              workflowId: wf.id,
              store: leased,
              connectors,
              trees: treeMap,
              ...(ex.value !== undefined ? { extractor: ex.value } : {}),
              ...(memoDir !== undefined ? { memoDir: resolve(memoDir) } : {}),
              ...(reviewers.length > 0 ? { approvals: { reviewers: new StaticReviewerRegistry(reviewers) } } : {}),
              lease: {
                client: authority,
                owner: 'server',
                ttlMs: 30_000,
                attach: (id, t) => leased.attach(id, 'server', t),
                detach: (id) => leased.detach(id),
              },
            });
          } catch (e) {
            skipped.push(`${wf.id}: ${(e as Error).message}`);
          }
        }
        if (Object.keys(runners).length === 0) return fail(`no workflow can run on this server:\n  ${skipped.join('\n  ')}`);
        const host = flag(args.flags, 'host') ?? '127.0.0.1';
        const api = createXoServer({
          token,
          host,
          port: Number(flag(args.flags, 'port') ?? '7433'),
          allowRemote: args.flags['allow-remote'] === true,
          runners,
          store,
          authority,
          replica,
          trees: treeMap,
        });
        const a = await api.listen();
        out(`xo serve listening on http://${a.host}:${a.port} (workflows: ${Object.keys(runners).join(', ')})`);
        for (const s of skipped) out(`  skipped ${s}`);
        await new Promise<void>((done) => {
          process.once('SIGINT', done);
          process.once('SIGTERM', done);
        });
        await api.close();
        return 0;
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  });
}
