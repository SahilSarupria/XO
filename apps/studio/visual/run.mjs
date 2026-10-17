#!/usr/bin/env node
// Studio visual regression: build, start a real API and Studio on throw-away data, seed synthetic content, capture the
// established screens in headless Chromium, compare with the approved references, write a report.
//
//   node apps/studio/visual/run.mjs [--mode compare|update-candidates] [--out <dir>] [--skip-build]
//
// Exit codes: 0 pass, 10 visual regression, 20 infrastructure failure (see lib/classify.mjs).
// It never modifies the repository: output goes under --out (default .xo-dev/visual/<unique>, which is git-ignored),
// and all service data lives in a fresh temporary directory that is deleted at the end.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InfraError, loadPlaywright } from './lib/browser.mjs';
import { classify } from './lib/classify.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { Recorder } from './lib/recorder.mjs';
import { writeReport } from './lib/report.mjs';
import { captureAll } from './screens.mjs';
import { EXIT, SYNTHETIC, TIMEOUTS } from './visual.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

function parseArgs(argv) {
  const opts = { mode: 'compare', out: undefined, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') opts.mode = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--skip-build') opts.skipBuild = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!['compare', 'update-candidates'].includes(opts.mode)) throw new Error(`--mode must be compare or update-candidates`);
  return opts;
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const out = resolve(opts.out ?? join(root, '.xo-dev', 'visual', runId));
  mkdirSync(join(out, 'logs'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'xo-studio-visual-'));

  const secrets = [];
  const redact = (t) => makeRedactor(secrets)(t);
  const logFile = join(out, 'logs', 'run.log');
  const say = (line) => {
    const text = redact(line);
    console.log(text);
    appendFileSync(logFile, `${text}\n`);
  };
  const children = [];
  const recorder = new Recorder({ outDir: out, baselinesDir: join(here, 'baselines'), mode: opts.mode });
  const info = { 'Run id': runId, Mode: opts.mode, Node: process.version };
  let infraError;

  // Children get only what they need, never the parent's environment (which may hold CI tokens).
  const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: work };

  const run = (label, cmd, args, { cwd = root, env = childEnv } = {}) => {
    say(`> ${label}`);
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 600_000 });
    appendFileSync(join(out, 'logs', `${label.replace(/\W+/g, '-')}.log`), redact(`${r.stdout ?? ''}${r.stderr ?? ''}`));
    if (r.status !== 0) {
      const tail = redact(`${r.stdout ?? ''}${r.stderr ?? ''}`)
        .trim()
        .split('\n')
        .slice(-12)
        .join('\n');
      throw new InfraError(`${label} failed (exit ${r.status ?? r.signal}).\n${tail}`);
    }
    return r.stdout ?? '';
  };

  const start = (name, cmd, args, { cwd, env }) => {
    const log = createWriteStream(join(out, 'logs', `${name}.log`));
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { name, child, exited: false, tail: [] };
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (d) => {
        const text = redact(d);
        log.write(text);
        record.tail = [...record.tail, ...text.split('\n')].slice(-15);
      });
    }
    child.on('exit', (code) => {
      record.exited = true;
      record.code = code;
    });
    children.push(record);
    return record;
  };

  const waitUntilUp = async (record, url, label, check = (r) => r.ok) => {
    const deadline = Date.now() + TIMEOUTS.serviceStartMs;
    while (Date.now() < deadline) {
      if (record.exited) throw new InfraError(`${label} stopped during start-up (exit ${record.code}).\n${record.tail.join('\n')}`);
      try {
        if (check(await fetch(url, { signal: AbortSignal.timeout(2000) }))) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new InfraError(`${label} did not answer at its address within ${TIMEOUTS.serviceStartMs / 1000}s.\n${record.tail.join('\n')}`);
  };

  const stopAll = async () => {
    for (const { child, exited } of children) if (!exited) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    for (const { child, exited } of children) if (!exited) child.kill('SIGKILL');
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      void stopAll().finally(() => process.exit(EXIT.infra));
    });
  }

  try {
    const { chromium, version } = loadPlaywright();
    info.Playwright = version;
    info.Commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'unknown';

    if (!opts.skipBuild) {
      run('build-api', 'npx', ['tsc', '-b', 'apps/api/tsconfig.json']);
      run('build-studio', 'npx', ['vite', 'build', '--outDir', join(work, 'studio-dist'), '--emptyOutDir'], {
        cwd: join(root, 'apps/studio'),
      });
    }

    const [apiPort, studioPort] = [await freePort(), await freePort()];
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const studioUrl = `http://127.0.0.1:${studioPort}`;
    const dataEnv = {
      API_KEYS_DIR: join(work, 'keys'),
      WORKSPACES_DIR: join(work, 'workspaces'),
      WORKSPACE_DATA_DIR: join(work, 'workspace-data'),
    };

    const issueKey = (identity) => {
      const text = run(`issue-key-${identity}`, 'npm', [
        'run',
        '--silent',
        'keys',
        '-w',
        '@xo/api',
        '--',
        'issue',
        identity,
        '--kind',
        'human',
        '--dir',
        dataEnv.API_KEYS_DIR,
      ]);
      const key = /xoak_[A-Za-z0-9_-]+/.exec(text)?.[0];
      if (key === undefined) throw new InfraError(`Could not issue a synthetic access key for ${identity}.`);
      secrets.push(key);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${key}`);
      return key;
    };
    const keys = { demo: issueKey(SYNTHETIC.demoIdentity), empty: issueKey(SYNTHETIC.emptyIdentity) };

    const api = start('api', process.execPath, ['run-api.mjs'], {
      cwd: join(root, 'apps/api'),
      env: { ...childEnv, ...dataEnv, PORT: String(apiPort), HOST: '127.0.0.1' },
    });
    await waitUntilUp(api, `${apiUrl}/health`, 'The API');
    say(`API up on port ${apiPort}`);

    run('seed', process.execPath, ['--import', 'tsx', 'visual/seed.mjs'], {
      cwd: join(root, 'apps/studio'),
      env: { ...childEnv, XO_API_URL: apiUrl, XO_API_KEY: keys.demo, XO_FIXTURE_PDF: join(root, SYNTHETIC.fixturePdf) },
    });

    // `vite preview` serves the production build and forwards /api to the API (preview inherits server.proxy from vite.config.ts).
    const studio = start(
      'studio',
      'npx',
      ['vite', 'preview', '--outDir', join(work, 'studio-dist'), '--host', '127.0.0.1', '--port', String(studioPort), '--strictPort'],
      { cwd: join(root, 'apps/studio'), env: { ...childEnv, XO_API_URL: apiUrl } },
    );
    await waitUntilUp(studio, `${studioUrl}/`, 'Studio');
    await waitUntilUp(studio, `${studioUrl}/api/health`, "Studio's connection to the API");
    say(`Studio up on port ${studioPort}`);

    const { chromiumVersion } = await captureAll({ chromium, baseUrl: studioUrl, keys, recorder });
    info.Chromium = chromiumVersion;
  } catch (e) {
    infraError = redact(e instanceof Error ? e.message : String(e));
    say(`INFRASTRUCTURE FAILURE: ${infraError}`);
    if (e instanceof Error && e.stack !== undefined) appendFileSync(logFile, `${redact(e.stack)}\n`);
  } finally {
    await stopAll();
    rmSync(work, { recursive: true, force: true });
    say('Services stopped and temporary data removed.');
  }

  let verdict;
  if (infraError !== undefined) verdict = classify({ infraError, results: recorder.results });
  else if (opts.mode === 'update-candidates') {
    const bad = recorder.results.filter((r) => r.status === 'functional');
    verdict =
      bad.length > 0
        ? {
            kind: 'regression',
            exitCode: EXIT.regression,
            headline: `${bad.length} screen(s) did not behave as expected, so their candidates are incomplete.`,
          }
        : {
            kind: 'pass',
            exitCode: EXIT.pass,
            headline: `Wrote ${recorder.results.length} candidate screenshots to candidates/. Nothing in the repository was changed.`,
          };
  } else verdict = classify({ infraError, results: recorder.results });

  const markdown = writeReport(out, { verdict, results: recorder.results, orphans: recorder.orphanedBaselines(), info, mode: opts.mode });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${verdict.kind}\nreport_dir=${out}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const title = {
      pass: 'Studio visual check passed',
      regression: 'Studio visual regression',
      infra: 'Studio visual check: infrastructure failure',
    }[verdict.kind];
    console.log(`::${verdict.kind === 'pass' ? 'notice' : 'error'} title=${title}::${redact(verdict.headline).split('\n')[0]}`);
  }
  say(`\n${verdict.headline}\nArtifacts: ${out}`);
  return verdict.exitCode;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Unexpected failure in the visual runner: ${e instanceof Error ? e.message : e}`);
    process.exit(EXIT.infra);
  },
);
