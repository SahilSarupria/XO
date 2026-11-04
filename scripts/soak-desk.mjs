#!/usr/bin/env node
/**
 * Crash-and-restart soak test for the automation engine. No model, no network.
 *
 *   npm run build && node scripts/soak-desk.mjs [--events 3000] [--kills 6] [--dup 0.1] [--out dir]
 *
 * A child process runs the engine over a file-drop inbox; the parent drops claim files at a steady pace, SIGKILLs the child at
 * random moments (real process death — no graceful shutdown), restarts it, and finally checks invariants against the on-disk
 * ledger and the handler's own side-effect log:
 *   1. the ledger hash chain verifies;
 *   2. every distinct claim was accepted exactly once (no duplicate accepts despite restarts and re-dropped files);
 *   3. every accepted job reached a terminal entry (completed or failed) — nothing lost, nothing left pending;
 *   4. every distinct claim's handler ran at least once (at-least-once under crashes), and the number of EXTRA executions is reported;
 *   5. memory (RSS) is sampled — it is reported, not asserted, because the ledger keeps its entries in memory by design (see output).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const dir = arg('out', join(tmpdir(), `xo-soak-${process.pid}`));

if (process.argv[2] === '--child') {
  const { AutomationEngine, FileDropTrigger, PermanentError } = await import('../packages/automation/dist/index.js');
  const wf = {
    id: 'soak',
    maxAttempts: 3,
    triggers: [new FileDropTrigger('inbox', { dir: join(dir, 'inbox'), pollMs: 50 })],
    run: async (ev, ctx) => {
      appendFileSync(join(dir, 'effects.log'), `${ev.payload.n} ${ctx.runId} ${ctx.attempt}\n`);
      const r = (ev.payload.n * 2654435761) % 1000; // deterministic per claim
      if (r < 20 && ctx.attempt < 2) throw new Error('transient failure'); // 2% fail once, then succeed
      if (r >= 990) throw new PermanentError('bad input'); // 1% fail permanently
      await new Promise((res) => setTimeout(res, 2));
      return {
        disposition: r % 7 === 0 ? 'needs_human' : 'completed',
        lane: r % 7 === 0 ? 'needs-human' : 'done',
        summary: `claim ${ev.payload.n}`,
      };
    },
  };
  const engine = new AutomationEngine({ dir: join(dir, 'state'), workflows: [wf], concurrency: 8, backoffBaseMs: 5 });
  await engine.start();
  setInterval(
    () => process.send?.({ rss: process.memoryUsage().rss, counters: engine.counters, ledger: engine.ledgerEntries.length }),
    500,
  );
  process.send?.({ ready: true });
  await new Promise(() => {});
}

const { HashChainLedger } = await import('../packages/automation/dist/index.js');
const N = Number(arg('events', '3000'));
const KILLS = Number(arg('kills', '6'));
const DUP = Number(arg('dup', '0.1'));
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'inbox'), { recursive: true });
writeFileSync(join(dir, 'effects.log'), '');

let child;
let spawns = 0;
const rss = [];
const start = () => {
  spawns++;
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--out', dir], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (m) => m.rss && rss.push({ t: Date.now(), rss: m.rss, ledger: m.ledger }));
};
start();
const killAt = new Set(Array.from({ length: KILLS }, (_, i) => Math.floor(((i + 1) / (KILLS + 1)) * N)));
const t0 = Date.now();
for (let n = 1; n <= N; n++) {
  writeFileSync(join(dir, 'inbox', `c${n}.json`), JSON.stringify({ claim_id: `c${n}`, n }));
  if (Math.random() < DUP) writeFileSync(join(dir, 'inbox', `dup-${n}.json`), JSON.stringify({ claim_id: `c${n}`, n })); // same content → same key
  if (killAt.has(n)) {
    child.kill('SIGKILL'); // real crash
    await new Promise((r) => child.once('exit', r));
    start();
  }
  if (n % 50 === 0) await new Promise((r) => setTimeout(r, 25)); // ~2000 events/s offered
}
// wait until the inbox is drained and the engine has settled everything it accepted
const pending = () =>
  existsSync(join(dir, 'state/state/pending'))
    ? readdirSync(join(dir, 'state/state/pending')).filter((f) => f.endsWith('.json')).length
    : 0;
const inboxLeft = () => readdirSync(join(dir, 'inbox')).filter((f) => f.endsWith('.json')).length;
for (let i = 0; i < 600 && (inboxLeft() > 0 || pending() > 0); i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 600));
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
const wallSec = (Date.now() - t0) / 1000;

const ledgerPath = join(dir, 'state/ledger.jsonl');
const v = await HashChainLedger.verifyFile(ledgerPath);
const entries = readFileSync(ledgerPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const accepted = entries.filter((e) => e.type === 'job.accepted');
const keys = accepted.map((e) => e.data.key);
const terminal = new Set(entries.filter((e) => e.type === 'job.completed' || e.type === 'job.failed').map((e) => e.data.runId));
const lost = accepted.filter((e) => !terminal.has(e.data.runId));
const effects = readFileSync(join(dir, 'effects.log'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split(' '));
const ran = new Set(effects.map((e) => e[0]));
const distinctAccepted = new Set(accepted.map((e) => e.data.key)).size;
const firstAttemptsPerClaim = new Map();
for (const [n, , attempt] of effects) if (attempt === '1') firstAttemptsPerClaim.set(n, (firstAttemptsPerClaim.get(n) ?? 0) + 1);
const reExecuted = [...firstAttemptsPerClaim.values()].filter((c) => c > 1).length;

const checks = [
  ['ledger hash chain verifies', v.ok, `${v.entries} entries`],
  [
    'every claim accepted exactly once',
    keys.length === distinctAccepted && distinctAccepted === N,
    `${distinctAccepted} distinct keys for ${N} claims, ${keys.length} accept entries`,
  ],
  [
    'no accepted job left unsettled',
    lost.length === 0 && pending() === 0,
    `${lost.length} without a terminal entry, ${pending()} pending files`,
  ],
  ["every claim's handler ran at least once", ran.size === N, `${ran.size}/${N}`],
];
console.log(
  `soak: ${N} claims (+~${Math.round(DUP * 100)}% duplicate drops), ${KILLS} SIGKILLs, ${spawns} engine processes, ${wallSec.toFixed(1)} s wall\n`,
);
for (const [name, ok, detail] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
console.log(
  `\n  info  claims whose first attempt ran more than once because a crash interrupted them: ${reExecuted} (at-least-once; handlers must be idempotent)`,
);
console.log(
  `  info  duplicates dropped by the engine: ${entries.filter((e) => e.type === 'job.duplicate').length}, recovered after crashes: ${entries.filter((e) => e.type === 'job.recovered').length}`,
);
if (rss.length > 1)
  console.log(
    `  info  RSS ${(rss[0].rss / 1048576).toFixed(0)} MB → ${(rss[rss.length - 1].rss / 1048576).toFixed(0)} MB, peak ${(Math.max(...rss.map((r) => r.rss)) / 1048576).toFixed(0)} MB (ledger entries held in memory: ${rss[rss.length - 1].ledger}; the ledger is NOT streamed, so memory grows with entries)`,
  );
console.log(
  '\n  Scope: one host, one process at a time, file-drop trigger, seconds-to-minutes. This is a crash/recovery soak, not a multi-hour endurance run.',
);
if (!arg('keep')) rmSync(dir, { recursive: true, force: true });
process.exit(checks.every((c) => c[1]) ? 0 : 1);
