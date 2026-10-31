import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AutomationEngine,
  FileDropTrigger,
  HashChainLedger,
  ScheduleTrigger,
  WebhookTrigger,
  networkNamespaceAvailable,
  type Trigger,
} from '@xo/automation';
import {
  buildArms,
  buildGoldXo,
  buildReport,
  compileManual,
  compilerGap,
  freightClaimWorkflow,
  generateEvalTasks,
  manualMarkdown,
  renderMarkdown,
  runEval,
  EvalAbortedError,
  PacedProvider,
  type EvalRecord,
  isTransportError,
  scorePackage,
  SimulatedModel,
  type ArmId,
} from '@xo/ab-eval';
import { createCapabilityLayer, XoExecutor } from '@xo/capability-layer';
import { OUTPUT_CONTRACT } from '@xo/ab-eval';
import type { CommandRegistry } from '../../command-registry.js';
import { resolveOperatorProvider } from './operator-provider.js';

const SUBSYSTEM = 'layer';
const flag = (f: Readonly<Record<string, string | boolean>>, n: string): string | undefined =>
  typeof f[n] === 'string' ? (f[n] as string) : undefined;
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e; // `xo ... | head` closing the pipe is not an error
});
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);

/** Cheapest set that still answers "does XO beat the same model alone / with the whole manual pasted in?" (+ the free router arm). */
const LEAN_ARMS: ArmId[] = ['plain', 'dump', 'xo_tools', 'xo_router'];
const ALL_ARMS: ArmId[] = ['plain', 'prompt', 'dump', 'xo_context', 'xo_tools', 'xo_router'];

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'detachable intelligence layer: ask, A/B evaluation, compiler gap, unattended desk');

  registry.register({
    name: 'ab-eval',
    subsystem: SUBSYSTEM,
    usage:
      'xo ab-eval [--arms plain,prompt,dump,xo_context,xo_tools,xo_router] [--trials n] [--concurrency n] [--limit n]\n' +
      '           [--seed n] [--style standard|variant] [--preset lean] [--rpm n] [--resume] [--include-compiled] [--price-in <usd/Mtok>] [--price-out <usd/Mtok>] [--out <dir>] [--self-test]\n' +
      '                                         A/B the Halvorsen freight scenario. Model/provider come from the environment:\n' +
      '                                         XO_MODEL, XO_PROVIDER (default anthropic) and the provider API key variable.\n' +
      '                                         --self-test uses simulated models to validate the harness (NOT a measurement).',
    run: async (args) => {
      const selfTest = args.flags['self-test'] === true;
      const seedFlag = flag(args.flags, 'seed');
      const styleFlag = flag(args.flags, 'style') ?? 'standard';
      if (styleFlag !== 'standard' && styleFlag !== 'variant') return fail('--style must be "standard" or "variant"');
      if (seedFlag !== undefined && !Number.isInteger(Number(seedFlag))) return fail('--seed must be an integer');
      let tasks = generateEvalTasks(seedFlag !== undefined ? Number(seedFlag) : undefined, styleFlag);
      const limit = Number(flag(args.flags, 'limit') ?? '0');
      if (limit > 0) tasks = tasks.filter((_, i) => i % Math.ceil(tasks.length / limit) === 0).slice(0, limit);
      const gold = buildGoldXo();
      const includeCompiled = args.flags['include-compiled'] === true;
      const compiled = includeCompiled ? (await compileManual()).bundle : undefined;
      let provider, providerId: string, model: string;
      if (selfTest) {
        const sim = new SimulatedModel(tasks);
        provider = sim;
        providerId = sim.id;
        model = 'sim-1';
      } else {
        const op = resolveOperatorProvider();
        if (!op.ok) return fail(op.error);
        ({ provider, providerId, model } = op.value);
      }
      const rpmFlag = flag(args.flags, 'rpm');
      const rpm = rpmFlag !== undefined ? Number(rpmFlag) : providerId === 'gemini' ? 4 : 0; // 4/min fits the strictest free tier (5 RPM); raise with --rpm (e.g. 12 for flash-lite); 0 disables
      if (!Number.isFinite(rpm) || rpm < 0) return fail('--rpm must be a non-negative number');
      if (rpm > 0) provider = new PacedProvider(provider, rpm);
      const arms = buildArms({ provider, model, gold, ...(compiled !== undefined ? { compiled } : {}) });
      const preset = flag(args.flags, 'preset');
      if (preset !== undefined && preset !== 'lean') return fail('--preset must be "lean"');
      const want = (flag(args.flags, 'arms')?.split(',') ?? [
        ...(preset === 'lean' ? LEAN_ARMS : ALL_ARMS),
        ...(includeCompiled ? (['compiled_context'] as ArmId[]) : []),
      ]) as ArmId[];
      const unknown = want.filter((a) => arms[a] === undefined);
      if (unknown.length > 0) return fail(`unknown arm(s): ${unknown.join(', ')}`);
      const trials = Math.max(1, Number(flag(args.flags, 'trials') ?? '1'));
      const outDirEarly = flag(args.flags, 'out');
      let last = 0;
      const partialPath = outDirEarly !== undefined ? join(resolve(outDirEarly), 'records.partial.jsonl') : undefined;
      let resume: EvalRecord[] = [];
      if (partialPath !== undefined) {
        await mkdir(resolve(outDirEarly as string), { recursive: true });
        if (args.flags['resume'] === true && existsSync(partialPath))
          resume = readFileSync(partialPath, 'utf8')
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => JSON.parse(l) as EvalRecord);
        else if (existsSync(partialPath)) await writeFile(partialPath, '');
        if (resume.length > 0) process.stderr.write(`  resuming: ${resume.length} saved records will not be re-run\n`);
      }
      let records;
      try {
        records = await runEval({
          arms: want.map((a) => arms[a]),
          tasks,
          trials,
          concurrency: Number(flag(args.flags, 'concurrency') ?? (providerId === 'gemini' ? '2' : '4')),
          resume,
          onProgress: (done, total, rec) => {
            if (partialPath !== undefined && !isTransportError(rec) && !resume.includes(rec))
              appendFileSync(partialPath, `${JSON.stringify({ ...rec, run: { ...rec.run, rawText: rec.run.rawText.slice(0, 2000) } })}\n`);
            if (done === total || done - last >= Math.max(1, Math.floor(total / 20))) {
              last = done;
              process.stderr.write(`\r  ${done}/${total}`);
            }
          },
        });
      } catch (e) {
        process.stderr.write('\n');
        if (e instanceof EvalAbortedError) return fail(`INVALID RUN — no results produced. ${e.message}`);
        throw e;
      }
      process.stderr.write('\n');
      const failedCalls = records.filter(isTransportError);
      const modelCalls = records.filter((r) => r.run.path === 'model').length;
      if (failedCalls.length > 0 && failedCalls.length / Math.max(1, modelCalls) > 0.02) {
        const outDir0 = flag(args.flags, 'out');
        if (outDir0 !== undefined) {
          await mkdir(resolve(outDir0), { recursive: true });
          await writeFile(join(outDir0, 'records.invalid.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
        }
        return fail(
          `INVALID RUN — ${failedCalls.length}/${modelCalls} model calls failed at the transport level (not wrong answers). ` +
            `First error: ${(failedCalls[0]?.run.error ?? '').replace(/\s+/g, ' ').slice(0, 1500)}`,
        );
      }
      const pin = flag(args.flags, 'price-in');
      const pout = flag(args.flags, 'price-out');
      const report = buildReport(
        records,
        {
          model,
          provider: providerId,
          date: new Date().toISOString().slice(0, 10),
          trials,
          selfTest,
          taskSet: `seed ${seedFlag ?? 'default'}, ${styleFlag} phrasing`,
        },
        pin !== undefined && pout !== undefined ? { inputPerMTok: Number(pin), outputPerMTok: Number(pout) } : undefined,
      );
      const md = renderMarkdown(report);
      const outDir = flag(args.flags, 'out');
      if (outDir !== undefined) {
        await mkdir(resolve(outDir), { recursive: true });
        await writeFile(join(outDir, 'report.md'), md);
        await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
        await writeFile(
          join(outDir, 'records.jsonl'),
          records.map((r) => JSON.stringify({ ...r, run: { ...r.run, rawText: r.run.rawText.slice(0, 2000) } })).join('\n'),
        );
      }
      out(md);
      return 0;
    },
  });

  registry.register({
    name: 'compiler-gap',
    subsystem: SUBSYSTEM,
    usage:
      'xo compiler-gap [--json] [--seed n] [--style standard|variant]\n' +
      '                                     Compile the Halvorsen manual and score the result against the hand-authored gold XO (no model needed).\n' +
      '                                     --seed picks a fresh task set; --style variant re-words the claims (held-out phrasing).',
    run: async (args) => {
      const seedFlag = flag(args.flags, 'seed');
      const styleFlag = flag(args.flags, 'style') ?? 'standard';
      if (styleFlag !== 'standard' && styleFlag !== 'variant') return fail('--style must be "standard" or "variant"');
      if (seedFlag !== undefined && !Number.isInteger(Number(seedFlag))) return fail('--seed must be an integer');
      const tasks = generateEvalTasks(seedFlag !== undefined ? Number(seedFlag) : undefined, styleFlag);
      const gold = scorePackage(buildGoldXo(), tasks);
      const { bundle } = await compileManual();
      const gap = compilerGap(gold, scorePackage(bundle, tasks));
      if (args.flags['json'] === true) out(JSON.stringify(gap, null, 2));
      else {
        out('Compiler vs gold XO (Halvorsen claims desk)');
        for (const c of gap.checks)
          out(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(40)} target ${c.target.padEnd(8)} actual ${c.actual}`);
        out(gap.passed ? '\ncompiled XO meets the parity bar' : '\ncompiled XO does NOT yet meet the parity bar');
      }
      return gap.passed ? 0 : 2;
    },
  });

  registry.register({
    name: 'ask',
    subsystem: SUBSYSTEM,
    usage:
      'xo ask --text "<claim text>" [--facts \'<json>\'] [--json]\n                                         Adjudicate one freight claim through the gold XO. Structured --facts are solved locally with no model.',
    run: async (args) => {
      const text = flag(args.flags, 'text') ?? '';
      const factsRaw = flag(args.flags, 'facts');
      if (text === '' && factsRaw === undefined) return fail('give --text and/or --facts');
      let facts: Record<string, unknown> | undefined;
      if (factsRaw !== undefined) {
        try {
          facts = JSON.parse(factsRaw) as Record<string, unknown>;
        } catch {
          return fail('--facts must be a JSON object');
        }
      }
      const bundle = buildGoldXo();
      const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
      const op = resolveOperatorProvider();
      const trees = JSON.parse(new TextDecoder().decode(bundle.components.find((c) => c.kind === 'decision_trees')!.data));
      const exec = new XoExecutor(
        layer,
        {
          preamble: OUTPUT_CONTRACT,
          knowledgeK: 9,
          temperature: 0,
          ...(op.ok ? { provider: op.value.provider, model: op.value.model } : {}),
        },
        trees,
      );
      const r = await exec.execute({ text: text || JSON.stringify(facts), ...(facts !== undefined ? { facts } : {}) });
      if (args.flags['json'] === true) out(JSON.stringify(r, null, 2));
      else {
        out(
          `path: ${r.path}   model calls: ${r.modelCalls}   tokens: ${r.usage.inputTokens}+${r.usage.outputTokens}   ${r.latencyMs.toFixed(1)} ms`,
        );
        out(`result: ${JSON.stringify(r.output)}`);
        for (const s of r.ruleTrace) out(`  · ${s}`);
        if (r.overridden) out('  ! safety gate overrode the proposed output');
        if (r.error) out(`note: ${r.error}${op.ok ? '' : ` (${op.error})`}`);
      }
      return r.output === null ? 2 : 0;
    },
  });

  registry.register({
    name: 'desk',
    subsystem: SUBSYSTEM,
    usage:
      'xo desk --state <dir> [--inbox <dir>] [--webhook-port <n>] [--every-ms <n>] [--model-fallback] [--duration-sec <n>]\n' +
      '                                         Run the freight claims desk unattended: triggers → sandboxed evaluation → outbox lanes → ledger.\n' +
      '                                         Webhook secret is read from XO_WEBHOOK_SECRET (never a flag). --model-fallback lets free-text\n' +
      '                                         claims use the operator-configured model; without it they go to a human. Requires a network\n' +
      '                                         namespace for the sandbox unless XO_SANDBOX_NETWORK=none.',
    run: async (args) => {
      const state = flag(args.flags, 'state');
      if (state === undefined) return fail('--state <dir> is required');
      const triggers: Trigger[] = [];
      const inbox = flag(args.flags, 'inbox');
      if (inbox !== undefined) triggers.push(new FileDropTrigger('inbox', { dir: resolve(inbox) }));
      const port = flag(args.flags, 'webhook-port');
      let hook: WebhookTrigger | undefined;
      if (port !== undefined) {
        const secret = process.env['XO_WEBHOOK_SECRET'];
        if (secret === undefined) return fail('set XO_WEBHOOK_SECRET (at least 16 characters) to enable the webhook');
        hook = new WebhookTrigger('webhook', { secret, port: Number(port) });
        triggers.push(hook);
      }
      const every = flag(args.flags, 'every-ms');
      if (every !== undefined) triggers.push(new ScheduleTrigger('heartbeat', { everyMs: Number(every) }));
      if (triggers.length === 0) return fail('enable at least one of --inbox, --webhook-port, --every-ms');
      const isolation = process.env['XO_SANDBOX_NETWORK'] === 'none' ? 'none' : 'required';
      if (isolation === 'required' && !networkNamespaceAvailable())
        return fail(
          'network isolation is required but unavailable on this host; set XO_SANDBOX_NETWORK=none to run with filesystem/process isolation only',
        );
      let provider, model: string | undefined;
      if (args.flags['model-fallback'] === true) {
        const op = resolveOperatorProvider();
        if (!op.ok) return fail(op.error);
        provider = op.value.provider;
        model = op.value.model;
      }
      const { workflow, sandbox } = freightClaimWorkflow({
        bundle: buildGoldXo(),
        triggers,
        networkIsolation: isolation,
        ...(provider !== undefined && model !== undefined ? { provider, model, maxModelCallsPerRun: 500 } : {}),
      });
      // Heartbeat payloads are not claims; the schedule trigger exists to show the pattern (e.g. a nightly sweep) — claims need facts/narrative.
      const st = await sandbox.selfTest();
      if (!st.enforced) return fail(`sandbox isolation self-test failed: ${st.failures.join('; ')}`);
      const engine = new AutomationEngine({ dir: resolve(state), workflows: [workflow], concurrency: 4 });
      await engine.start();
      out(
        `desk running · sandbox isolation verified (network ${sandbox.isolation.network ? 'blocked' : 'NOT blocked'}) · ledger ${engine.ledgerPath}`,
      );
      if (hook !== undefined) out(`webhook listening on http://127.0.0.1:${hook.address().port}/hook`);
      const stop = async (): Promise<void> => {
        await engine.stop();
        await sandbox.close();
        out(`stopped · ${JSON.stringify(engine.counters)} · ledger head ${engine.ledgerHead.slice(0, 16)}…`);
      };
      const secs = Number(flag(args.flags, 'duration-sec') ?? '0');
      await new Promise<void>((done) => {
        const finish = (): void => void stop().then(done);
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
        if (secs > 0) setTimeout(finish, secs * 1000);
      });
      return 0;
    },
  });

  registry.register({
    name: 'ledger-verify',
    subsystem: SUBSYSTEM,
    usage: "xo ledger-verify <ledger.jsonl>     Verify a desk ledger's hash chain (detects edited, removed or reordered entries)",
    run: async (args) => {
      const p = args.positionals[0];
      if (p === undefined) return fail('give the ledger path');
      const v = await HashChainLedger.verifyFile(resolve(p));
      out(v.ok ? `OK · ${v.entries} entries, chain intact` : `BROKEN at entry ${v.brokenAt}: ${v.reason}`);
      return v.ok ? 0 : 3;
    },
  });
  void manualMarkdown;
}
