#!/usr/bin/env node
// Runs the REAL-MODEL escalation-policy evaluation end to end: preflight -> install/build -> live run (hard token budget) -> summary.
// Cross-platform (Windows/macOS/Linux). On Windows prefer run.ps1, which takes the API key without echoing it.
//
//   node scripts/escalation-eval/run.mjs [options]        (GEMINI_API_KEY must be in the environment)
//
//   --budget-tokens <n>        HARD token cap for the whole run (default 150000; the run refuses to start without one)
//   --min-interval-ms <n>      minimum gap between PROVIDER calls, for free-tier rate limits (default 6000)
//   --cache-dir <dir>          durable cache shared by all arms (default <repo>/.eval-output/<timestamp>/cache)
//   --report <file>            JSON report path (default <repo>/.eval-output/<timestamp>/report.json)
//   --model <id>               Gemini model id (default: the repository default)
//   --price-in <usd/1k> --price-out <usd/1k>   optional, to get a cost ESTIMATE (the repo has no verified Gemini price)
//   --skip-install             do not run `npm ci`
//   --dry-run                  preflight and print the plan; make NO network call and spend nothing
//   --ack-data-leaves-machine  acknowledge that the evaluated text is sent to Google (otherwise you are asked to type SEND)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const die = (msg, code = 1) => {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(code);
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(root, '.eval-output', stamp);
const budget = Number(opt('--budget-tokens', '150000'));
const interval = Number(opt('--min-interval-ms', '6000'));
const cacheDir = resolve(opt('--cache-dir', join(outDir, 'cache')));
const reportPath = resolve(opt('--report', join(outDir, 'report.json')));
const summaryPath = reportPath.replace(/\.json$/i, '') + '.summary.md';
const dry = flag('--dry-run');

console.log('XO escalation-policy evaluation: REAL-MODEL run');
console.log('-----------------------------------------------');

// ---- preflight (nothing here costs money) --------------------------------------------------------------------------------
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 15))
  die(`Node ${process.versions.node} is too old; this repository needs Node >= 22.15.0 (https://nodejs.org).`);
for (const f of [
  'packages/compiler/test/knowledge/escalation-eval.test.ts',
  'packages/compiler/test/knowledge/escalation-eval-set.ts',
  'examples/vertical-test/burglary-policy.pdf',
]) {
  if (!existsSync(join(root, f)))
    die(
      `missing ${f}. Check out the branch that contains the evaluation harness (feat/inference-cache-and-policy plus the evaluation commit).`,
    );
}
const key = (process.env.GEMINI_API_KEY ?? '').trim();
if (!key)
  die(
    'GEMINI_API_KEY is not set. Use run.ps1 (it prompts for the key without echoing it), or set the variable for this shell session only.',
  );
if (/\s/.test(key)) die('GEMINI_API_KEY contains whitespace. Re-copy it without quotes or a trailing newline.');
if (!Number.isInteger(budget) || budget < 20000)
  die('--budget-tokens must be an integer >= 20000 (the run needs roughly 70k tokens; the default cap is 150000).');
if (!Number.isFinite(interval) || interval < 0) die('--min-interval-ms must be a number >= 0.');

console.log(`Repository       : ${root}`);
console.log(`Node             : ${process.versions.node}`);
console.log(
  `HARD token budget: ${budget} (the guard refuses further calls once spent; a denied call makes the run invalid and is reported)`,
);
console.log(`Call pacing      : >= ${interval} ms between provider calls`);
console.log(`Cache (shared)   : ${cacheDir}`);
console.log(`Report           : ${reportPath}`);
console.log('Expected usage   : ~43 real model calls (one per eligible unit; all other arms replay the cache), roughly 70k tokens.');
console.log('');
console.log('DATA WARNING: the evaluated units are text from examples/vertical-test/*.pdf. burglary-policy.pdf and Aastha.pdf appear to');
console.log('contain REAL personal data (a name, address, PAN, phone numbers, emails) and an internal operations document. Running this');
console.log('SENDS that text to Google. On the free tier Google may use submitted content to improve its products (per its pricing page');
console.log('when this was written; confirm current terms). Use a paid-tier key, or do not run this, if that is not acceptable.');
console.log('');

if (dry) {
  console.log('--dry-run: preflight passed. No network call was made and nothing was spent.');
  process.exit(0);
}

if (!flag('--ack-data-leaves-machine')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type SEND to proceed (anything else cancels): ')).trim();
  rl.close();
  if (answer !== 'SEND') die('cancelled. Nothing was sent or spent.', 0);
}

// Connectivity check WITHOUT the key, so a blocked network fails now rather than mid-run.
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  await fetch('https://generativelanguage.googleapis.com/', { signal: ctrl.signal });
  clearTimeout(t);
} catch (e) {
  die(`cannot reach generativelanguage.googleapis.com (${e.cause?.code ?? e.message}). Check your network, VPN or proxy.`);
}

const run = (cmd, args, cwd, extraEnv = {}) =>
  spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: cmd !== process.execPath, env: { ...process.env, ...extraEnv } }).status ?? 1;

mkdirSync(cacheDir, { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

if (!flag('--skip-install') || !existsSync(join(root, 'node_modules'))) {
  console.log('\n[1/3] Installing dependencies (npm ci)...');
  if (run('npm', ['ci', '--no-audit', '--no-fund'], root) !== 0) die('npm ci failed.');
}
console.log('\n[2/3] Building workspace packages (npm run typecheck)...');
if (run('npm', ['run', 'typecheck'], root) !== 0) die('build/typecheck failed.');

console.log('\n[3/3] Running the live evaluation...');
const env = {
  XO_LIVE_ESCALATION_EVAL: '1',
  XO_INFERENCE_PROVIDER: 'gemini',
  XO_COMPILER_MAX_TOTAL_TOKENS: String(budget),
  XO_EVAL_CACHE_DIR: cacheDir,
  XO_EVAL_REPORT_PATH: reportPath,
  XO_EVAL_MIN_INTERVAL_MS: String(interval),
  ...(opt('--model') ? { XO_GEMINI_MODEL: opt('--model') } : {}),
  ...(opt('--price-in') ? { XO_EVAL_PRICE_IN_PER_1K: opt('--price-in') } : {}),
  ...(opt('--price-out') ? { XO_EVAL_PRICE_OUT_PER_1K: opt('--price-out') } : {}),
};
const status = run(
  process.execPath,
  ['--import', 'tsx', '--test', 'test/knowledge/escalation-eval.test.ts'],
  join(root, 'packages', 'compiler'),
  env,
);

if (!existsSync(reportPath)) {
  console.error('\nThe run produced no report. Common causes:');
  console.error('  - 401/403: the key is invalid, or the Gemini API is not enabled for it');
  console.error('  - 429: rate limit or quota exhausted (try a larger --min-interval-ms, or wait for the quota to reset)');
  console.error('  - the model id is unavailable (try --model with a model your key can use)');
  console.error('  - the token budget was too small (the run refuses further calls once it is spent)');
  die(`live test exited with status ${status}.`);
}
console.log('\n=============== RESULTS ===============\n');
const sum = spawnSync(process.execPath, [join(here, 'summarize.mjs'), reportPath, summaryPath], { stdio: 'inherit' });
console.log(`\nFull report : ${reportPath}`);
console.log(`Summary     : ${summaryPath}`);
console.log('Send me the summary file (it contains no key, prompts or document text).');
console.log('When finished: remove the key from this shell and consider revoking it if it was shared.');
process.exit(status !== 0 || sum.status !== 0 ? 1 : 0);
