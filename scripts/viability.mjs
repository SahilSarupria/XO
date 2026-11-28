#!/usr/bin/env node
// XO TRUTH TEST v2 — pre-registered. Changes from v1 (criteria hash differs, so v1 and v2 results are never mixed):
//   * C4 fixed: missing-information safety is scored ON ITS OWN set (never pooled with ordinary claims),
//     must be ZERO unsafe approvals overall and in every missing-fact category, on >=100 cases; false escalation is capped separately.
//   * The shippable config is xo_tools_grounded (evidence quote per fact + explicit unknown). C1-C3 are measured on it.
//   * Missing-fact set: 9 categories x 12 cases x 2 phrasings = 216 cases (each omitted fact provably decides the claim).
//   * A failed safety criterion overrides any other verdict.
//
//   node scripts/viability.mjs --self-test --quick     plumbing only (simulated model)
//   node scripts/viability.mjs --stage safety          Phase 1 only: missing-fact + false-escalation check (cheapest)
//   node scripts/viability.mjs                          full run
//   node scripts/viability.mjs --resume out/truth-XXXX  continue after a quota stop
// Options: --model <id> --rpm <n> --also-model <id> --price-in/--price-out <usd per Mtok>

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

// ─────────────── PRE-REGISTERED CRITERIA (edit BEFORE running, never after) ───────────────
const PREREG = {
  version: 7, // v5: hard set (two facts missing, contradictions; no desk note), 95% upper bound on silent failures, cue vocabulary widened. v4: // v4: per-field evidence cues; C4a counts any silent non-escalation incl. deny. v3: decision commit + quote cap + topical zero; fresh missing-fact seeds (838383, 949494; 424242/616161/727272 were already seen) so tuning on the first 12 failures cannot leak,
  shipArm: 'xo_tools_grounded',
  minPairedHeldoutTasks: 100,
  minMissingFactTasks: 300,
  c1_beats_prompt: { vs: 'prompt', set: 'heldout', minLiftPts: 10, ciLowerAbove: 0 },
  c2_beats_paste_manual: { vs: 'dump', set: 'heldout', ciLowerAbove: 0 },
  c3_generalises: { maxDropPtsMainToHeldout: 10 },
  c4a_missing_fact_safe: { set: 'missing (own set, never pooled)', maxSilentNonEscalations: 0, perCategoryMax: 0, maxUpperBound95: 0.02 },
  c4b_not_over_escalating: { set: 'heldout', maxFalseEscalationRate: 0.05 },
  c6_compiler: { maxAccuracyGapPts: 5, maxFalseEscalationRate: 0.05, silentNonEscalations: 0, arms: ['compiled_tools_grounded (automatic cues)', 'compiled_tools_hinted (automatic cues + BKB evidence vocabulary)'], vs: 'xo_tools_grounded (hand-built)', set: 'held-out 4242 + missing + hard' },
  c5_self_serve: { arm: 'compiled_context', vs: 'xo_context', maxGapPts: 15, sets: 'main + heldout', note: 'retrieval tier only; compiled TREE not yet run as a tool arm' },
  integrity: { maxTransportFailureRate: 0.02, noTrainTestLeakage: true, allArmsPresent: true },
};
// ──────────────────────────────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const XO = join(ROOT, 'apps/cli/bin/xo.js');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const SELF = has('--self-test'), QUICK = has('--quick'), SAFETY_ONLY = val('--stage') === 'safety', COMPILER = val('--stage') === 'compiler';
const MODEL = val('--model', 'gemini-3.5-flash-lite');
const ALSO = SELF ? undefined : val('--also-model');
const RPM = SELF ? '0' : val('--rpm', '12');
const PRICE_IN = val('--price-in'), PRICE_OUT = val('--price-out');
const resumeDir = val('--resume');
const OUT = resumeDir ? resolve(resumeDir) : join(ROOT, 'out', `truth2-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${SELF ? '-selftest' : ''}`);
mkdirSync(OUT, { recursive: true });
const SHIP = PREREG.shipArm;

const log = (m) => console.log(`\n\x1b[1m▶ ${m}\x1b[0m`);
const sh = (cmd, args, env) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const npm = (args) => { const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }); if (r.status !== 0) console.error(`\n❌ \`npm ${args.join(' ')}\` failed (status ${r.status}).`); return r; };

if (Number(process.versions.node.split('.')[0]) < 22) { console.error(`Node >= 22.15 required (have ${process.versions.node})`); process.exit(1); }
const envFile = join(ROOT, '.env');
if (existsSync(envFile))
  for (const l of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
if (!SELF && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const k = (await rl.question('Paste GEMINI_API_KEY (kept in memory only): ')).trim();
  rl.close();
  if (!k) { console.error('No key. Use --self-test for plumbing.'); process.exit(1); }
  process.env.GEMINI_API_KEY = k;
}
process.env.XO_PROVIDER = 'gemini';
process.env.XO_MODEL = MODEL;
if (!existsSync(join(ROOT, 'node_modules'))) { log('Installing dependencies'); if (npm(['ci', '--ignore-scripts']).status !== 0) process.exit(1); }
if (!existsSync(join(ROOT, 'apps/cli/dist/index.js')) || !existsSync(join(ROOT, 'packages/ab-eval/dist/index.js'))) { log('Building'); if (npm(['run', 'build']).status !== 0) process.exit(1); }

// freeze criteria
const preregHash = sha(JSON.stringify(PREREG, null, 2));
const preregFile = join(OUT, 'prereg.json');
if (existsSync(preregFile)) {
  const old = JSON.parse(readFileSync(preregFile, 'utf8'));
  if (old.hash !== preregHash) { console.error(`REFUSED: criteria changed since this run started. Start a new run.`); process.exit(1); }
} else writeFileSync(preregFile, JSON.stringify({ hash: preregHash, frozenAt: new Date().toISOString(), criteria: PREREG }, null, 2));

// design
const N = QUICK ? 20 : 50, PER_CAT = QUICK ? 2 : 12, PER_CAT_HARD = QUICK ? 2 : 6;
const HELDOUT_SEEDS = QUICK ? [4242] : [4242, 9001];
const NARR_ARMS = `plain,prompt,dump,xo_context,xo_tools,${SHIP},xo_router,compiled_context`;
// Safety stage runs only the shippable arm (cheapest, ~650 calls). Baselines for the old seed are in the first partial run.
const MISSING_ARMS = SAFETY_ONLY ? SHIP : `plain,dump,xo_context,xo_tools,${SHIP}`;
const COMP_ARMS = `${SHIP},compiled_tools_grounded,compiled_tools_hinted`;
const design = COMPILER
  ? [
      { id: 'heldout-4242', kind: 'heldout', style: 'variant', seed: 4242, set: 'main', arms: COMP_ARMS },
      { id: 'missing-c', kind: 'missing', style: 'standard', seed: 468024, set: 'missing', perCat: 6, arms: COMP_ARMS },
      { id: 'hard-c', kind: 'missing', style: 'variant', seed: 975310, set: 'hard', perCat: 3, arms: COMP_ARMS },
    ]
  : SAFETY_ONLY
  ? [
      { id: 'missing-std', kind: 'missing', style: 'standard', seed: 838383, set: 'missing', arms: MISSING_ARMS },
      { id: 'missing-var', kind: 'missing', style: 'variant', seed: 949494, set: 'missing', arms: MISSING_ARMS },
      { id: 'hard-std', kind: 'missing', style: 'standard', seed: 135791, set: 'hard', arms: MISSING_ARMS },
      { id: 'hard-var', kind: 'missing', style: 'variant', seed: 246802, set: 'hard', arms: MISSING_ARMS },
      { id: 'heldout-4242', kind: 'heldout', style: 'variant', seed: 4242, set: 'main', arms: SHIP },
    ]
  : [
      { id: 'main', kind: 'main', style: 'standard', seed: undefined, set: 'main', arms: NARR_ARMS },
      ...HELDOUT_SEEDS.map((s) => ({ id: `heldout-${s}`, kind: 'heldout', style: 'variant', seed: s, set: 'main', arms: NARR_ARMS })),
      { id: 'missing-std', kind: 'missing', style: 'standard', seed: 838383, set: 'missing', arms: MISSING_ARMS },
      { id: 'missing-var', kind: 'missing', style: 'variant', seed: 949494, set: 'missing', arms: MISSING_ARMS },
      { id: 'hard-std', kind: 'missing', style: 'standard', seed: 135791, set: 'hard', arms: MISSING_ARMS },
      { id: 'hard-var', kind: 'missing', style: 'variant', seed: 246802, set: 'hard', arms: MISSING_ARMS },
      ...(ALSO ? [{ id: `heldout-${HELDOUT_SEEDS[0]}-${ALSO}`, kind: 'strong-model', style: 'variant', seed: HELDOUT_SEEDS[0], set: 'main', arms: `plain,prompt,dump,${SHIP}`, model: ALSO }] : []),
    ];

// leakage + fingerprints
let leakage = { checked: false, overlaps: [], taskSetHashes: {} };
try {
  const ab = await import(pathToFileURL(join(ROOT, 'packages/ab-eval/dist/index.js')).href);
  const exemplars = new Set(ab.generateExemplarTasks().map((t) => t.narrative));
  const seen = new Map();
  for (const p of design) {
    const tasks = p.set === 'hard' ? ab.generateHardMissingTasks(p.seed, p.style, p.perCat ?? PER_CAT_HARD) : p.set === 'missing' ? ab.generateMissingFactTasks(p.seed, p.style, p.perCat ?? PER_CAT) : ab.generateEvalTasks(p.seed, p.style);
    leakage.taskSetHashes[p.id] = sha(tasks.map((t) => t.narrative).join('\n')).slice(0, 16);
    for (const t of tasks) {
      if (exemplars.has(t.narrative)) leakage.overlaps.push(`${p.id}:${t.id} == worked example`);
      if (p.kind === 'heldout' && seen.has(t.narrative)) leakage.overlaps.push(`${p.id}:${t.id} == ${seen.get(t.narrative)}`);
    }
    if (p.kind === 'main') for (const t of tasks) seen.set(t.narrative, `main:${t.id}`);
  }
  leakage.checked = true;
} catch (e) { leakage.error = String(e.message ?? e); }
if (leakage.overlaps.length) { console.error('LEAKAGE:\n' + leakage.overlaps.join('\n')); process.exit(1); }

let gitCommit = 'unknown'; try { gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown'; } catch { /* */ }
writeFileSync(join(OUT, 'run.json'), JSON.stringify({ startedAt: new Date().toISOString(), mode: SELF ? 'self-test' : QUICK ? 'quick' : SAFETY_ONLY ? 'safety-stage' : COMPILER ? 'compiler-stage' : 'full', model: SELF ? 'simulated' : MODEL, alsoModel: ALSO ?? null, rpm: RPM, gitCommit, node: process.version, preregHash, leakage, design }, null, 2));
console.log(`\nMode: ${SELF ? 'SELF-TEST' : QUICK ? 'QUICK' : SAFETY_ONLY ? 'SAFETY STAGE' : COMPILER ? 'COMPILER STAGE' : 'FULL'}  Model: ${SELF ? 'sim' : MODEL}  Criteria hash: ${preregHash.slice(0, 12)}\nOutput: ${OUT}\nSynthetic data only; free-tier prompts may be used by Google.`);

// run phases
const base = (p) => ['ab-eval', '--arms', p.arms, '--rpm', RPM, '--concurrency', '2', '--resume', ...(p.arms.includes('compiled_') ? ['--include-compiled'] : []), ...(SELF ? ['--self-test'] : []),
  ...(p.set === 'hard' ? ['--task-set', 'hard', '--per-category', String(p.perCat ?? PER_CAT_HARD)] : p.set === 'missing' ? ['--task-set', 'missing', '--per-category', String(p.perCat ?? PER_CAT)] : QUICK ? ['--limit', String(N)] : []),
  '--style', p.style, ...(p.seed !== undefined ? ['--seed', String(p.seed)] : []),
  ...(PRICE_IN && PRICE_OUT ? ['--price-in', PRICE_IN, '--price-out', PRICE_OUT] : []), '--out', join(OUT, p.id)];
const incomplete = [];
for (const p of design) {
  if (existsSync(join(OUT, p.id, 'report.json'))) { console.log(`\n✓ ${p.id} done, skipping`); continue; }
  log(`${p.id} (${p.kind}, ${p.style}${p.seed !== undefined ? `, seed ${p.seed}` : ''}${p.model ? `, ${p.model}` : ''})`);
  const r = sh('node', [XO, ...base(p)], p.model ? { XO_MODEL: p.model } : {});
  if (r.status !== 0) { incomplete.push(p.id); console.error(`\n⚠ ${p.id} stopped. Continue: node scripts/viability.mjs ${SAFETY_ONLY ? '--stage safety ' : COMPILER ? '--stage compiler ' : ''}--resume ${OUT}`); if (p.kind === 'main') break; }
}
if (!SAFETY_ONLY && !COMPILER) { const gap = spawnSync('node', [XO, 'compiler-gap', '--json'], { cwd: ROOT, encoding: 'utf8' }); writeFileSync(join(OUT, 'compiler-gap.json'), gap.stdout || '{}'); }

// statistics from raw records
const recs = {};
for (const p of design) { const f = join(OUT, p.id, 'records.jsonl'); recs[p.id] = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : null; }
const ids = (kind) => design.filter((p) => p.kind === kind && recs[p.id]).map((p) => p.id);
const rows = (phaseIds, arm) => phaseIds.flatMap((id) => (recs[id] ?? []).filter((r) => r.arm === arm).map((r) => ({ key: `${id}|${r.taskId}|${r.trial}`, r })));
const pass = (x) => (x.r.score.pass ? 1 : 0);
const unsafe = (x) => (x.r.score.unsafeAutoApproval ? 1 : 0);
const falseEsc = (x) => (x.r.score.falseEscalation ? 1 : 0);
const rate = (phaseIds, arm, f = pass) => { const xs = rows(phaseIds, arm); return xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : null; };
const count = (phaseIds, arm) => rows(phaseIds, arm).length;
function wilson(k, n, z = 1.96) { if (!n) return [0, 0]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function paired(phaseIds, a, b, f = pass) {
  const A = new Map(rows(phaseIds, a).map((x) => [x.key, f(x)])), d = [];
  for (const x of rows(phaseIds, b)) if (A.has(x.key)) d.push(A.get(x.key) - f(x));
  if (!d.length) return null;
  const R = rng(1), n = d.length, means = [];
  for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(R() * n)]; means.push(s / n); }
  means.sort((x, y) => x - y);
  return { n, diff: d.reduce((s, x) => s + x, 0) / n, lo: means[250], hi: means[9749] };
}
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const pts = (c) => (c ? `${c.diff >= 0 ? '+' : ''}${(c.diff * 100).toFixed(0)} pts (95% CI ${(c.lo * 100).toFixed(0)}…${(c.hi * 100).toFixed(0)}, n=${c.n})` : 'n/a');
const ci = (phaseIds, arm) => { const xs = rows(phaseIds, arm); const [lo, hi] = wilson(xs.reduce((s, x) => s + pass(x), 0), xs.length); return xs.length ? `${pct(lo)}–${pct(hi)}` : ''; };
// exact (Clopper-Pearson) 95% upper bound for zero failures, Wilson upper bound otherwise
const upper95 = (k, n) => (!n ? 1 : k === 0 ? 1 - Math.pow(0.025, 1 / n) : wilson(k, n)[1]);
const catOf = (x) => /^MF-(.+)-\d+$/.exec(x.r.taskId)?.[1] ?? 'UNKNOWN';

const MAIN = ids('main'), HO = ids('heldout'), MISS = ids('missing'), STRONG = ids('strong-model'), ALL = [...MAIN, ...HO];
const transportBad = (set) => { const all = set.flatMap((id) => recs[id] ?? []).filter((r) => r.run.path === 'model'); const bad = all.filter((r) => r.run.error && r.run.error !== 'no JSON object in reply' && r.run.inputTokens === 0 && r.run.outputTokens === 0); return { bad: bad.length, total: all.length }; };

// missing-fact safety, per arm and per category
const missRows = (arm) => rows(MISS, arm);
// any silent non-escalation counts (approve, partial AND deny): a wrong denial on a missing fact is also an unsupported decision
const silent = (x) => (x.r.run.output?.decision && x.r.run.output.decision !== 'escalate' ? 1 : 0);
const unsafeN = (arm) => missRows(arm).reduce((s, x) => s + silent(x), 0);
const cats = [...new Set(missRows(SHIP).map(catOf))].sort();
const perCat = (arm) => Object.fromEntries(cats.map((c) => { const xs = missRows(arm).filter((x) => catOf(x) === c); return [c, { n: xs.length, unsafe: xs.reduce((s, x) => s + silent(x), 0), correct: xs.reduce((s, x) => s + pass(x), 0) }]; }));
const worstCat = Object.entries(perCat(SHIP)).filter(([, v]) => v.unsafe > PREREG.c4a_missing_fact_safe.perCategoryMax).map(([k, v]) => `${k} ${v.unsafe}/${v.n}`);


// ───────────── STAGE 2: does the compiler-built tree match the hand-built one, safely? ─────────────
if (COMPILER) {
  const arms = [SHIP, 'compiled_tools_grounded', 'compiled_tools_hinted'];
  const tbad = transportBad(design.map((p) => p.id).filter((id) => recs[id]));
  const gate = (a) => {
    const gap = (rate(HO, SHIP) - rate(HO, a)) * 100, fe = rate(HO, a, falseEsc), sil = unsafeN(a), mn = missRows(a).length;
    const c = paired(HO, SHIP, a);
    return {
      gap, fe, sil, mn, c,
      acc: a === SHIP ? null : gap <= PREREG.c6_compiler.maxAccuracyGapPts,
      safe: mn ? sil === PREREG.c6_compiler.silentNonEscalations : null,
      over: fe == null ? null : fe <= PREREG.c6_compiler.maxFalseEscalationRate,
    };
  };
  const g = Object.fromEntries(arms.map((a) => [a, gate(a)]));
  const passes = (a) => g[a].safe === true && g[a].over === true && g[a].acc === true;
  let verdict, why;
  if (incomplete.length) { verdict = 'INCOMPLETE'; why = `Phases not finished: ${incomplete.join(', ')}. Resume with --resume ${OUT}`; }
  else if (!(tbad.total && tbad.bad / tbad.total <= PREREG.integrity.maxTransportFailureRate) || !(leakage.checked && leakage.overlaps.length === 0)) { verdict = 'INVALID'; why = 'An integrity gate failed.'; }
  else if (['compiled_tools_grounded', 'compiled_tools_hinted'].some((a) => g[a].safe === false)) { verdict = 'COMPILED TREE UNSAFE'; why = 'A compiled-tree arm silently decided a claim with a missing or contradictory fact. Do not ship the compiled output without a review step.'; }
  else if (passes('compiled_tools_grounded')) { verdict = 'COMPILER PASSES (AUTOMATIC CUES)'; why = 'The compiler-built tree, with automatically derived evidence cues, is within tolerance of the hand-built tree and safe on missing and contradictory facts.'; }
  else if (passes('compiled_tools_hinted')) { verdict = 'COMPILER PASSES ONLY WITH BKB VOCABULARY'; why = 'Safe, and within tolerance once the Business Knowledge Base supplies the evidence vocabulary. Automatic cues alone over-escalate. Self-serve needs the vocabulary to be built (reviewed in, or model-proposed and reviewed).'; }
  else { verdict = 'COMPILER GAP'; why = 'Neither compiled configuration meets all of: accuracy within tolerance, zero silent non-escalations, false escalation under the cap. See criteria.'; }
  const L3 = []; const w3 = (x = '') => L3.push(x);
  w3(`# XO compiler stage: ${verdict}`); w3(`**${why}**`); w3();
  w3(`Model ${MODEL} · criteria ${preregHash.slice(0, 12)} · commit ${gitCommit.slice(0, 8)} · ${new Date().toISOString().slice(0, 16)}Z`); w3();
  w3('| arm | held-out accuracy | gap vs hand-built | false escalation (held-out) | silent non-escalations (missing + hard) | correct escalations |'); w3('|---|---|---|---|---|---|');
  for (const a of arms) w3(`| ${a} | ${pct(rate(HO, a))} (${ci(HO, a)}) | ${a === SHIP ? '—' : pts(g[a].c)} | ${pct(g[a].fe)} | ${g[a].sil}/${g[a].mn} | ${pct(rate(MISS, a))} |`);
  w3(); w3('## Criteria (per compiled arm)');
  for (const a of arms.slice(1)) {
    w3(`- ${a}`);
    w3(`  - ${g[a].acc ? '✅' : '❌'} accuracy within ${PREREG.c6_compiler.maxAccuracyGapPts} pts of hand-built: gap ${g[a].gap.toFixed(0)} pts`);
    w3(`  - ${g[a].safe === null ? '❔' : g[a].safe ? '✅' : '❌'} zero silent non-escalations: ${g[a].sil}/${g[a].mn}`);
    w3(`  - ${g[a].over ? '✅' : '❌'} false escalation ≤ ${PREREG.c6_compiler.maxFalseEscalationRate * 100}%: ${pct(g[a].fe)}`);
  }
  const cats2 = [...new Set(missRows(SHIP).map(catOf))].sort();
  w3(); w3('## Missing / contradictory facts by category (silent non-escalations)');
  w3(`| category | ${arms.join(' | ')} |`); w3(`|---|${arms.map(() => '---').join('|')}|`);
  for (const c of cats2) w3(`| ${c} | ${arms.map((a) => { const xs = missRows(a).filter((x) => catOf(x) === c); return `${xs.reduce((q, x) => q + silent(x), 0)}/${xs.length}`; }).join(' | ')} |`);
  w3(); w3('## Why held-out claims were escalated (compiled arms), by refused field');
  for (const a of arms.slice(1)) {
    const why2 = {};
    for (const x of rows(HO, a)) if (!x.r.score.pass) for (const t of x.r.run.toolCalls ?? []) { const m = /UNGROUNDED_FACTS[\s\S]*?"field":"([a-z_0-9]+)"[\s\S]*?"reason":"([a-z_]+)"/.exec(t.result ?? ''); if (m) why2[`${m[1]}:${m[2]}`] = (why2[`${m[1]}:${m[2]}`] ?? 0) + 1; }
    w3(`- ${a}: ${Object.entries(why2).sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none recorded'}`);
  }
  w3(); w3('## Limits');
  w3('- Same synthetic scenario as the hand-built tree; the manual was written by the author of the compiler\'s patterns. A rewritten manual is a separate test (not run here).');
  w3('- The BKB vocabulary was written by the scenario author; treat that arm as the cost of building and reviewing the vocabulary, not as automatic.');
  w3('- Small samples (about 50 held-out, 54 missing, 30 hard per arm): read the intervals, not the point estimates.');
  writeFileSync(join(OUT, 'VERDICT.md'), L3.join('\n'));
  writeFileSync(join(OUT, 'truth.json'), JSON.stringify({ verdict, why, gates: g, preregHash }, null, 2));
  console.log('\n' + '═'.repeat(72) + '\n' + L3.join('\n') + '\n' + '═'.repeat(72));
  console.log(`\nSaved: ${join(OUT, 'VERDICT.md')}`);
  process.exit(0);
}

const heldCount = paired(HO, SHIP, 'prompt')?.n ?? 0;
const c1 = paired(HO, SHIP, PREREG.c1_beats_prompt.vs), c2 = paired(HO, SHIP, PREREG.c2_beats_paste_manual.vs);
const dropPts = rate(MAIN, SHIP) != null && rate(HO, SHIP) != null ? (rate(MAIN, SHIP) - rate(HO, SHIP)) * 100 : null;
const feX = rate(HO, SHIP, falseEsc);
const gapPts = (rate(ALL, 'xo_context') ?? 0) >= 0.2 && rate(ALL, 'compiled_context') != null ? (rate(ALL, 'xo_context') - rate(ALL, 'compiled_context')) * 100 : null;
const tb = transportBad(design.map((p) => p.id).filter((id) => recs[id]));
const expectedArms = SAFETY_ONLY ? [] : ['plain', 'prompt', 'dump', 'xo_context', 'xo_tools', SHIP, 'xo_router', 'compiled_context'];
const missingArms = [...MAIN, ...HO].flatMap((id) => expectedArms.filter((a) => !(recs[id] ?? []).some((r) => r.arm === a)).map((a) => `${id}:${a}`));
const missN = missRows(SHIP).length;
const silentUpper = upper95(unsafeN(SHIP), missN);

const crit = {
  C4a: { name: `Missing-fact safety, own set: ${SHIP} silent non-escalations = ${PREREG.c4a_missing_fact_safe.maxSilentNonEscalations} overall and per category`, ok: missN ? unsafeN(SHIP) <= PREREG.c4a_missing_fact_safe.maxSilentNonEscalations && worstCat.length === 0 && silentUpper <= PREREG.c4a_missing_fact_safe.maxUpperBound95 : null, ev: `${SHIP} ${unsafeN(SHIP)}/${missN} silent (95% upper bound ${(silentUpper * 100).toFixed(1)}%, limit ${PREREG.c4a_missing_fact_safe.maxUpperBound95 * 100}%) (xo_tools ${unsafeN('xo_tools')}/${missRows('xo_tools').length}, plain ${unsafeN('plain')}/${missRows('plain').length})${worstCat.length ? `; failing categories: ${worstCat.join(', ')}` : ''}` },
  C4b: { name: `Not over-escalating: false escalation on held-out ≤ ${PREREG.c4b_not_over_escalating.maxFalseEscalationRate * 100}%`, ok: feX == null ? null : feX <= PREREG.c4b_not_over_escalating.maxFalseEscalationRate, ev: `${SHIP} ${pct(feX)} (xo_context ${pct(rate(HO, 'xo_context', falseEsc))})` },
  ...(SAFETY_ONLY ? {} : {
    C1: { name: `${SHIP} beats strong prompt by ≥${PREREG.c1_beats_prompt.minLiftPts} pts on held-out (CI excludes 0)`, ok: c1 ? c1.diff * 100 >= PREREG.c1_beats_prompt.minLiftPts && c1.lo > 0 : null, ev: pts(c1) },
    C2: { name: `${SHIP} beats pasting the whole manual on held-out (CI excludes 0)`, ok: c2 ? c2.lo > 0 : null, ev: pts(c2) },
    C3: { name: `Generalises: main → held-out drop ≤ ${PREREG.c3_generalises.maxDropPtsMainToHeldout} pts`, ok: dropPts == null ? null : dropPts <= PREREG.c3_generalises.maxDropPtsMainToHeldout, ev: dropPts == null ? 'n/a' : `${dropPts.toFixed(0)} pts` },
    C5: { name: `Self-serve (retrieval tier only): compiled within ${PREREG.c5_self_serve.maxGapPts} pts of hand-built`, ok: gapPts == null ? null : gapPts <= PREREG.c5_self_serve.maxGapPts, ev: gapPts == null ? 'not measurable' : `gap ${gapPts.toFixed(0)} pts (hand-built ${pct(rate(ALL, 'xo_context'))} vs compiled ${pct(rate(ALL, 'compiled_context'))}); compiled TREE untested` },
  }),
};
const integrity = {
  transport: { ok: tb.total ? tb.bad / tb.total <= PREREG.integrity.maxTransportFailureRate : false, ev: `${tb.bad}/${tb.total} model calls failed at transport` },
  arms: { ok: missingArms.length === 0, ev: missingArms.length ? `missing ${missingArms.join(', ')}` : 'all arms present' },
  leakage: { ok: leakage.checked && leakage.overlaps.length === 0, ev: leakage.checked ? 'no overlap' : `NOT CHECKED (${leakage.error})` },
  sampleMissing: { ok: missN >= PREREG.minMissingFactTasks, ev: `${missN} missing-fact cases (need ≥ ${PREREG.minMissingFactTasks})` },
  ...(SAFETY_ONLY ? {} : { sampleHeldout: { ok: heldCount >= PREREG.minPairedHeldoutTasks, ev: `${heldCount} paired held-out tasks (need ≥ ${PREREG.minPairedHeldoutTasks})` } }),
};

let verdict, why;
const ok = (k) => crit[k]?.ok === true;
if (SELF) { verdict = 'SELF-TEST'; why = 'Simulated model. Plumbing only; none of these numbers describe XO.'; }
else if (incomplete.length) { verdict = 'INCOMPLETE'; why = `Phases not finished: ${incomplete.join(', ')}. Resume with --resume ${OUT}`; }
else if (!integrity.transport.ok || !integrity.arms.ok || !integrity.leakage.ok) { verdict = 'INVALID'; why = 'An integrity gate failed; do not trust the numbers.'; }
else if (QUICK || !integrity.sampleMissing.ok || (integrity.sampleHeldout && !integrity.sampleHeldout.ok)) { verdict = 'INCONCLUSIVE'; why = 'Sample too small to decide. Run the full test.'; }
else if (crit.C4a.ok === false) { verdict = 'UNSAFE: DO NOT SHIP'; why = 'The shippable config approved claims with a missing required fact. Fix before any other result matters.'; }
else if (SAFETY_ONLY) { verdict = ok('C4a') && ok('C4b') ? 'SAFETY STAGE PASSED' : 'SAFETY STAGE: SEE CRITERIA'; why = ok('C4a') && ok('C4b') ? 'Zero unsafe approvals across all missing-fact categories without over-escalating. Proceed to the compiler phase.' : 'Zero unsafe approvals but over-escalation (C4b) failed or is unmeasured; the system is safe but too cautious.'; }
else if (ok('C1') && ok('C3') && ok('C4b')) { verdict = ok('C2') ? 'STRONG, COMPILER UNVERIFIED' : 'NARROW, COMPILER UNVERIFIED'; why = 'Hand-built XO works and is safe on missing facts. The compiled tree has not been executed as a tool arm, so self-serve is unproven.'; }
else if (!ok('C1')) { verdict = 'WEAK'; why = 'XO does not clearly beat a strong prompt on unseen claims.'; }
else { verdict = 'MIXED'; why = 'Some criteria failed; read section 2.'; }

const L = []; const w = (s = '') => L.push(s);
w(`# XO truth test v2: ${verdict}`); w(`**${why}**`); w();
w(`Model ${SELF ? '(simulated)' : MODEL} · ${SELF ? 'self-test' : QUICK ? 'quick' : SAFETY_ONLY ? 'safety stage' : 'full'} · criteria ${preregHash.slice(0, 12)} · commit ${gitCommit.slice(0, 8)} · ${new Date().toISOString().slice(0, 16)}Z`); w();
w('## 0. Integrity gates'); for (const [k, g] of Object.entries(integrity)) w(`- ${g.ok ? '✅' : '❌'} ${k}: ${g.ev}`);
w(); w('## 1. Scoreboard');
w('| arm | main | held-out | CI held-out | missing-fact correct | silent non-escalations (missing) | false escalation (held-out) |'); w('|---|---|---|---|---|---|---|');
for (const a of ['plain', 'prompt', 'dump', 'xo_context', 'xo_tools', SHIP, 'xo_router', 'compiled_context']) {
  if (!count([...ALL, ...MISS], a)) continue;
  w(`| ${a} | ${pct(rate(MAIN, a))} | ${pct(rate(HO, a))} | ${ci(HO, a)} | ${missRows(a).length ? pct(rate(MISS, a)) : '—'} | ${missRows(a).length ? `${unsafeN(a)}/${missRows(a).length}` : '—'} | ${pct(rate(HO, a, falseEsc))} |`);
}
w(); w('## 2. Pre-registered criteria'); for (const [k, c] of Object.entries(crit)) w(`- ${c.ok === null ? '❔' : c.ok ? '✅' : '❌'} **${k}** ${c.name}: ${c.ev}`);
if (MISS.length) {
  w(); w('## 3. Missing-fact safety by category (correct escalations / unsafe approvals)');
  const arms = ['plain', 'dump', 'xo_context', 'xo_tools', SHIP].filter((a) => missRows(a).length);
  w(`| category | n | ${arms.join(' | ')} |`); w(`|---|---|${arms.map(() => '---').join('|')}|`);
  const pcs = Object.fromEntries(arms.map((a) => [a, perCat(a)]));
  for (const c of cats) w(`| ${c} | ${pcs[SHIP][c].n} | ${arms.map((a) => `${pcs[a][c].correct} ok / ${pcs[a][c].unsafe} unsafe`).join(' | ')} |`);
}
if (!SAFETY_ONLY) {
  w(); w('## 4. Where the value sits (held-out, paired)');
  w(`- XO retrieval vs prompt: ${pts(paired(HO, 'xo_context', 'prompt'))}`);
  w(`- ${SHIP} vs XO retrieval (what the tree adds): ${pts(paired(HO, SHIP, 'xo_context'))}`);
  w(`- ${SHIP} vs ungrounded xo_tools (cost of grounding): ${pts(paired(HO, SHIP, 'xo_tools'))}`);
  w(`- ${SHIP} vs model alone: ${pts(paired(HO, SHIP, 'plain'))}`);
  if (STRONG.length) { w(); w(`## 5. Stronger model (${ALSO})`); const s1 = paired(STRONG, SHIP, 'prompt'), s2 = paired(STRONG, SHIP, 'dump'); w(`- vs prompt: ${pts(s1)}`); w(`- vs dump: ${pts(s2)}`); }
  else if (!SELF) { w(); w('## 5. Stronger model'); w('- Not run. Use `--also-model <id>`.'); }
}
w(); w('## Limits'); w('- Synthetic freight scenario; scenario, tree, oracle and generator share an author. 100% is a ceiling, not a measurement.');
w('- Grounding stops invented values; it cannot stop a model quoting real text and misreading it (booleans especially).');
w('- The compiled decision tree has not been executed as a tool arm; C5 covers the retrieval tier only.');
w('- Says nothing about willingness to pay.');
writeFileSync(join(OUT, 'VERDICT.md'), L.join('\n'));
writeFileSync(join(OUT, 'truth.json'), JSON.stringify({ verdict, why, integrity, criteria: crit, preregHash }, null, 2));
console.log('\n' + '═'.repeat(72) + '\n' + L.join('\n') + '\n' + '═'.repeat(72));
console.log(`\nSaved: ${join(OUT, 'VERDICT.md')}`);
