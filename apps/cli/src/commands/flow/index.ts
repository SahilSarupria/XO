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
  reconcile,
  StaticReviewerRegistry,
  WorkflowRunner,
  compareShadow,
  buildAuditBundle,
  eventProblem,
  explainRun,
  renderExplanation,
  verifyAuditBundle,
  type AuditBundle,
  type EventScalar,
  type Reviewer,
} from '@xo/workflow-runtime';
import { FileTokenStore, createXoServer, fileAuditSink, resolveForHost } from '@xo/server';
import { join } from 'node:path';
import type { CommandRegistry } from '../../command-registry.js';
import { buildImplementations, type OperatorPolicyFile } from './bindings.js';
import { loadWorkflowBundle, type LoadedWorkflowBundle } from './bundle.js';
import { capsFromFlags, extractorFor } from './extractor.js';
import { PROMOTE_USAGE, runPromote } from './promote.js';
import { rateLimitsFromFlags, stateStores } from './runtime-options.js';

const SUBSYSTEM = 'flow';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const flag = (f: Readonly<Record<string, string | boolean>>, n: string): string | undefined =>
  typeof f[n] === 'string' ? (f[n] as string) : undefined;

/**
 * The workflows and trees to run or serve: from a VERIFIED package (`--bundle`) or from loose files. Mixing them is refused, because then it would not be
 * clear which workflows the signature covers.
 */
async function inputsFrom(
  flags: Readonly<Record<string, string | boolean>>,
  file: string | undefined,
): Promise<
  { ok: true; comp: WorkflowComponent; treeMap: Map<string, DecisionTree>; loaded?: LoadedWorkflowBundle } | { ok: false; error: string }
> {
  const bundlePath = flag(flags, 'bundle');
  const trees = flag(flags, 'trees');
  if (bundlePath !== undefined) {
    if (file !== undefined || trees !== undefined)
      return { ok: false, error: '--bundle replaces <workflows.json> and --trees; do not pass both' };
    const loaded = await loadWorkflowBundle(bundlePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    for (const w of loaded.value.warnings) out(w);
    out(`package: ${loaded.value.bundle.manifest.name}@${loaded.value.bundle.manifest.version} — trust: ${loaded.value.trust}`);
    return { ok: true, comp: loaded.value.component, treeMap: new Map(loaded.value.trees.map((t) => [t.id, t])), loaded: loaded.value };
  }
  if (file === undefined) return { ok: false, error: 'give <workflows.json> (or --bundle <package.xo>)' };
  const treeMap = new Map<string, DecisionTree>();
  if (trees !== undefined) for (const t of parseTrees(JSON.parse(readFileSync(resolve(trees), 'utf8'))) ?? []) treeMap.set(t.id, t);
  return { ok: true, comp: load(file, trees), treeMap };
}

/** Subcommands other than `run` and `serve` always work from a loose file; the usage check has already refused its absence, this narrows the type. */
function requireFile(file: string | undefined): string {
  if (file === undefined) throw new Error('a <workflows.json> argument is required');
  return file;
}

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
      'xo flow resolve --bundle <package.xo|dir> --family <name> [--capabilities chat,tool_use] [--json]   What a host would get from a verified package (same logic as /v1/loader/resolve)\n' +
      '      xo flow reconcile --runs <dir> [--json]   External writes whose outcome is unknown or settled by lookup (exit 1 if any need attention; reads journals only)\n' +
      'xo flow validate <workflows.json> [--trees <decision_trees.json>]            Strict fail-closed validation (exit 3 on any error)\n' +
      'xo flow event <workflows.json>|--bundle <pkg> --workflow <id> --runs <dir> --name <event> --correlation <value> --event-id <id> [--input <json payload>]   Deliver one inbound event and resume runs waiting for it (deduplicated by --event-id)\n' +
      'xo flow dead-letters --runs <dir> [--json]   Steps that ended failed or escalated, stored for a person (read-only)\n' +
      'xo flow compare <workflows.json> --workflow <id> --runs <dir> --human <csv> --key <input> --field <result>   Shadow runs vs human decisions (run with --shadow first)\n' +
      'xo flow explain <workflows.json> --workflow <id> --runs <dir> --run <runId> [--json]   Why a run did what it did, from its verified journal\n' +
      'xo flow audit-export <workflows.json> --workflow <id> --runs <dir> --run-ids a,b --key <pem> --out <file> [--policy p.json] [--signer name]   Signed audit bundle\n' +
      'xo flow audit-verify <bundle.json> --pubkey <pem>   Verify signature, merkle root, hash chains\n' +
      PROMOTE_USAGE.split('\n')
        .map((l) => l)
        .join('\n') +
      '\n' +
      'xo flow link <a.json> <b.json> [...] [--names a,b] [--order a,b] [--out merged.json]   Load several XOs together; overlaps and conflicts reported, unresolved ones blocked (exit 2)\n' +
      'xo flow report <workflows.json>                                              Declared determinism class per step and workflow\n' +
      'xo flow run <workflows.json>|--bundle <package.xo|dir> [--memo-dir <dir>] --workflow <id> --input <json> --runs <dir>     Run durably; optional --policy <policy.json> --trees <file> --dry-run [--rate-limit bank=2:5,slack=1]\n' +
      '                                       [--dedupe <key>]  (file connectors only; credentials come from XO_SECRET_* env; no model, no network)',
    run: async (args) => {
      const [sub, file] = args.positionals;
      if (sub === 'reconcile') {
        // needs only the run directory: it reads journals and calls nothing
        const runs = flag(args.flags, 'runs');
        if (runs === undefined) return fail('usage: xo flow reconcile --runs <dir> [--json]');
        const rep = await reconcile(new RunStore(resolve(runs)));
        if (args.flags['json'] === true) out(JSON.stringify(rep, null, 2));
        else {
          out(
            `${rep.runs} run(s) read; ${rep.effects.filter((e) => e.status === 'resolved').length} external write(s) settled without a plain outcome, ${rep.effects.filter((e) => e.status !== 'resolved').length} need attention.`,
          );
          for (const e of rep.effects)
            out(
              `  [${e.status}] run ${e.runId} step ${e.step}: ${e.connector}.${e.operation}${e.key !== undefined ? ` key ${e.key}` : ''} (intent ${e.intentAt}) — ${e.detail}`,
            );
          if (rep.needsAttention)
            out(
              'Resume pending runs with the runner; for [ambiguous] entries check the destination by hand. Nothing was sent or changed by this command.',
            );
        }
        return rep.needsAttention ? 1 : 0;
      }
      if (sub === 'promote') return runPromote(args.positionals, args.flags);
      if (sub === 'dead-letters') {
        // reads the dead-letter store only; changes nothing
        const runs = flag(args.flags, 'runs');
        if (runs === undefined) return fail('usage: xo flow dead-letters --runs <dir> [--json]');
        const items = await stateStores(resolve(runs)).deadLetters.list();
        if (args.flags['json'] === true) out(JSON.stringify(items, null, 2));
        else {
          out(`${items.length} dead letter(s). Each is also an escalation or a failed run; none was dropped.`);
          for (const d of items)
            out(`  [${d.disposition}] run ${d.runId} step ${d.step}: ${d.code} after ${d.attempts} attempt(s) — ${d.message}`);
        }
        return 0;
      }
      if (sub === 'resolve') {
        const bundlePath = flag(args.flags, 'bundle');
        const family = flag(args.flags, 'family');
        if (bundlePath === undefined || family === undefined)
          return fail('usage: xo flow resolve --bundle <package.xo|dir> --family <name> [--capabilities chat,tool_use] [--json]');
        const loaded = await loadWorkflowBundle(bundlePath);
        if (!loaded.ok) return fail(loaded.error);
        for (const w of loaded.value.warnings) out(w);
        const caps = (flag(args.flags, 'capabilities') ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        const r = resolveForHost(loaded.value.bundle, { family, capabilities: caps });
        if (args.flags['json'] === true) out(JSON.stringify({ trust: loaded.value.trust, ...r }, null, 2));
        else {
          out(`trust: ${loaded.value.trust}`);
          out(`host ${family} [${caps.join(', ')}] reaches ${r.level}`);
          out(`consumes: ${r.consumed.join(', ') || '(nothing)'}`);
          for (const k of r.skipped) out(`skips ${k.kind}: ${k.reason}`);
          out(`workflows on a model-free runner: ${JSON.stringify(r.workflows)}`);
        }
        return 0;
      }
      if (sub === undefined || (file === undefined && !(args.flags['bundle'] !== undefined && (sub === 'run' || sub === 'event'))))
        return fail('usage: xo flow <validate|report|run|resolve|reconcile> <workflows.json>');
      try {
        const trees = flag(args.flags, 'trees');
        if (sub === 'validate') {
          const comp = load(requireFile(file), trees);
          const n = negotiateWorkflows(comp, DETERMINISTIC_HOST);
          out(`OK · ${comp.workflows.length} workflow(s), ${comp.connectors.length} connector(s)`);
          for (const w of n.runnable)
            out(`  runnable on a deterministic-only host: ${w}${n.modelFree.includes(w) ? ' (no model needed)' : ''}`);
          for (const r of n.refused) out(`  needs more than a deterministic-only host: ${r.workflow}: ${r.reasons.join('; ')}`);
          return 0;
        }
        if (sub === 'report') {
          for (const wf of load(requireFile(file), trees).workflows) {
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
        if (sub === 'run' || sub === 'event') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const inputRaw = flag(args.flags, 'input');
          if (id === undefined || runs === undefined || (sub === 'run' && inputRaw === undefined))
            return fail('--workflow, --input and --runs are required');
          const inputs = await inputsFrom(args.flags, file);
          if (!inputs.ok) return fail(inputs.error);
          const { comp, treeMap } = inputs;
          const policyPath = flag(args.flags, 'policy');
          const policy: OperatorPolicyFile =
            policyPath !== undefined ? JSON.parse(readFileSync(resolve(policyPath), 'utf8')) : { connectors: {} };
          const bound = await buildImplementations(comp, policy);
          if (!bound.ok) return fail(bound.error);
          const implementations = bound.value;
          const ex = extractorFor(comp, id);
          if (!ex.ok) return fail(ex.error);
          const memoDir = flag(args.flags, 'memo-dir');
          const caps = capsFromFlags(args.flags, resolve(runs));
          if (!caps.ok) return fail(caps.error);
          const limits = rateLimitsFromFlags(
            args.flags,
            comp.connectors.map((c) => c.id),
          );
          if (!limits.ok) return fail(limits.error);
          const state = stateStores(resolve(runs));
          const runner = new WorkflowRunner({
            component: comp,
            workflowId: id,
            store: new RunStore(resolve(runs)),
            ...state,
            ...(limits.value !== undefined ? { rateLimits: limits.value } : {}),
            connectors: new ConnectorHost({ component: comp, policy, implementations, vault: new EnvVault() }),
            trees: treeMap,
            ...(ex.value !== undefined ? { extractor: ex.value } : {}),
            ...(memoDir !== undefined ? { memoDir: resolve(memoDir) } : {}),
            ...(caps.value !== undefined ? { caps: caps.value } : {}),
            dryRun: args.flags['dry-run'] === true,
            shadow: args.flags['shadow'] === true,
          });
          if (sub === 'event') {
            // deliver one inbound event and resume this workflow's runs that wait for it
            const name = flag(args.flags, 'name');
            const correlation = flag(args.flags, 'correlation');
            const eventId = flag(args.flags, 'event-id');
            if (name === undefined || correlation === undefined || eventId === undefined)
              return fail('--name, --correlation and --event-id are required (and --input <json payload>, default {})');
            let payload: unknown;
            try {
              payload = inputRaw === undefined ? {} : JSON.parse(inputRaw);
            } catch {
              return fail('--input is not valid JSON');
            }
            const problem = eventProblem({ name, correlation, eventId, payload });
            if (problem !== undefined) return fail(`invalid event: ${problem}`);
            const d = await runner.deliverEvent({ name, correlation, eventId, payload: payload as Record<string, EventScalar> });
            out(JSON.stringify(d, null, 2));
            return 0;
          }
          const dedupe = flag(args.flags, 'dedupe');
          const r = await runner.start({ inputs: JSON.parse(inputRaw as string), ...(dedupe !== undefined ? { dedupeKey: dedupe } : {}) });
          out(JSON.stringify(r, null, 2));
          return r.state === 'completed' ? 0 : r.state === 'escalated' || r.state === 'waiting' ? 2 : 3;
        }
        if (sub === 'explain') {
          const id = flag(args.flags, 'workflow');
          const runs = flag(args.flags, 'runs');
          const runId = flag(args.flags, 'run');
          if (id === undefined || runs === undefined || runId === undefined)
            return fail('--workflow, --runs and --run <run id> are required');
          const wf = load(requireFile(file), trees).workflows.find((w) => w.id === id);
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
          const bytes = readFileSync(resolve(requireFile(file)));
          const wf = load(requireFile(file), trees).workflows.find((w) => w.id === id);
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
          const v = verifyAuditBundle(
            JSON.parse(readFileSync(resolve(requireFile(file)), 'utf8')) as AuditBundle,
            readFileSync(resolve(pub), 'utf8'),
          );
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
          const wf = load(requireFile(file), trees).workflows.find((w) => w.id === id);
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
      '                        Local HTTP API (runs, approvals, leases, ledger sync, loader resolve). Auth: --tokens <file> (per-client scoped tokens; see `xo token`) or, for loopback only, XO_SERVER_TOKEN (>= 24 chars). Never a token on a flag.\n' +
      '                        [--tls-cert <pem> --tls-key <pem>] [--tls-ca <pem> --require-client-cert] [--behind-tls-proxy] [--audit-log <file>]: built-in TLS (1.2+), optional mutual TLS, an explicit statement that a proxy you run terminates TLS, and an append-only record of every refusal (no credentials).\n' +
      '                        Free-text workflows use the operator model (XO_PROVIDER/XO_MODEL/<vendor>_API_KEY, optional XO_EXTRACTOR_*); workflows that need none never read it. [--memo-dir <dir>] reuses validated facts for identical cases. [--daily-model-calls <n>] [--daily-effects <n>] persisted daily caps (exceeding one escalates, never drops).\n' +
      '                        [--rate-limit bank=2:5,slack=1] per-connector call limits (calls/second[:burst], per process). Dead letters (<runs>/dead-letters) and inbound events (<runs>/events, POST /v1/events, scope `event`) live under --runs.\n' +
      '                        Binds to loopback by default. A non-loopback --host needs --allow-remote AND (--tls-cert/--tls-key or --behind-tls-proxy) AND --tokens; it is not claimed public-internet-ready (docs/SERVER_HARDENING.md).',
    run: async (args) => {
      // authentication: per-client scoped tokens (--tokens <file>), or the legacy shared secret from the environment (loopback only; the server refuses it elsewhere)
      const tokensPath = flag(args.flags, 'tokens') ?? process.env['XO_TOKEN_FILE'];
      const legacy = process.env['XO_SERVER_TOKEN'];
      if (tokensPath === undefined && (legacy === undefined || legacy.length < 24))
        return fail(
          'give --tokens <file> (see `xo token create`), or set XO_SERVER_TOKEN to a secret of at least 24 characters (loopback only)',
        );
      if (tokensPath !== undefined && legacy !== undefined) process.stderr.write('note: --tokens is set, so XO_SERVER_TOKEN is ignored\n');
      let tokenStore: FileTokenStore | undefined;
      if (tokensPath !== undefined) {
        try {
          tokenStore = FileTokenStore.open(resolve(tokensPath));
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      const tlsCert = flag(args.flags, 'tls-cert');
      const tlsKey = flag(args.flags, 'tls-key');
      const tlsCa = flag(args.flags, 'tls-ca');
      if ((tlsCert === undefined) !== (tlsKey === undefined)) return fail('--tls-cert and --tls-key go together');
      if (tlsCert === undefined && (tlsCa !== undefined || args.flags['require-client-cert'] === true))
        return fail('--tls-ca / --require-client-cert need --tls-cert and --tls-key');
      const auditPath = flag(args.flags, 'audit-log');
      const file = flag(args.flags, 'workflows');
      const runs = flag(args.flags, 'runs');
      if (runs === undefined || (file === undefined && flag(args.flags, 'bundle') === undefined))
        return fail('--runs and (--workflows <file> or --bundle <package.xo|dir>) are required');
      try {
        const inputs = await inputsFrom(args.flags, file);
        if (!inputs.ok) return fail(inputs.error);
        const { comp, treeMap } = inputs;
        const policyPath = flag(args.flags, 'policy');
        const policy: OperatorPolicyFile =
          policyPath !== undefined ? JSON.parse(readFileSync(resolve(policyPath), 'utf8')) : { connectors: {} };
        const bound = await buildImplementations(comp, policy);
        if (!bound.ok) return fail(bound.error);
        const implementations = bound.value;
        const memoDir = flag(args.flags, 'memo-dir');
        const caps = capsFromFlags(args.flags, resolve(runs));
        if (!caps.ok) return fail(caps.error);
        const limits = rateLimitsFromFlags(
          args.flags,
          comp.connectors.map((c) => c.id),
        );
        if (!limits.ok) return fail(limits.error);
        const approvers = flag(args.flags, 'approvers');
        const reviewers: Reviewer[] = approvers !== undefined ? JSON.parse(readFileSync(resolve(approvers), 'utf8')) : [];
        const base = resolve(runs);
        const store = new RunStore(join(base, 'journal'));
        const authority = new LeaseAuthority(join(base, 'leases'), store);
        const replica = new LedgerReplica(join(base, 'forks'), store);
        const leased = new LeasedRunStore(authority, store);
        const connectors = new ConnectorHost({ component: comp, policy, implementations, vault: new EnvVault() });
        const state = stateStores(base);
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
              ...state,
              ...(limits.value !== undefined ? { rateLimits: limits.value } : {}),
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
          ...(tokenStore !== undefined ? { tokens: tokenStore } : { token: legacy as string }),
          ...(tlsCert !== undefined && tlsKey !== undefined
            ? {
                tls: {
                  cert: readFileSync(resolve(tlsCert)),
                  key: readFileSync(resolve(tlsKey)),
                  ...(tlsCa !== undefined ? { ca: readFileSync(resolve(tlsCa)) } : {}),
                  ...(args.flags['require-client-cert'] === true ? { requireClientCert: true } : {}),
                },
              }
            : {}),
          ...(args.flags['behind-tls-proxy'] === true ? { behindTlsProxy: true } : {}),
          ...(auditPath !== undefined ? { audit: fileAuditSink(resolve(auditPath)) } : {}),
          host,
          port: Number(flag(args.flags, 'port') ?? '7433'),
          allowRemote: args.flags['allow-remote'] === true,
          runners,
          store,
          authority,
          replica,
          events: state.events,
          trees: treeMap,
          // a verified package also backs /v1/loader/resolve and /v1/receipts; loose files serve workflows only
          ...(inputs.loaded !== undefined ? { bundle: inputs.loaded.bundle } : {}),
        });
        const a = await api.listen();
        out(
          `xo serve listening on ${tlsCert !== undefined ? 'https' : 'http'}://${a.host}:${a.port} (workflows: ${Object.keys(runners).join(', ')})`,
        );
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
