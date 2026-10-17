#!/usr/bin/env node
// XO developer launcher. No dependencies; works on macOS, Linux and Windows.
//
//   npm run setup    one-time: check tools, install, create .env, build the API, create a dev access key
//   npm run dev      start the API and Studio together and tell you where to open it
//   npm run desktop  start the API (if needed) and the XO Studio desktop app, configured from .env
//   npm run doctor   check everything and say exactly what to fix
//   npm run smoke    run Studio's live contract check against the running dev API
//
// Everything it creates lives in ./.xo-dev (git-ignored). Delete that folder to start from scratch.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.xo-dev');
const keyFile = join(dataDir, 'dev-key.txt');
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const npm = isWin ? 'npm.cmd' : 'npm';

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${c(32, '✔')} ${s}`);
const bad = (s) => console.log(`${c(31, '✘')} ${s}`);
const warn = (s) => console.log(`${c(33, '!')} ${s}`);
const step = (s) => console.log(`\n${c(1, s)}`);

/** Reads .env (KEY=VALUE lines) without overriding variables already set in the shell. */
function loadEnv() {
  const file = join(root, '.env');
  const env = { ...process.env };
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line
      .slice(i + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

function settings(env) {
  return {
    apiPort: Number(env.PORT ?? 4000),
    studioPort: Number(env.STUDIO_PORT ?? 5173),
    host: env.HOST ?? '127.0.0.1',
    keys: env.API_KEYS_DIR ?? join(dataDir, 'keys'),
    workspaces: env.WORKSPACES_DIR ?? join(dataDir, 'workspaces'),
    workspaceData: env.WORKSPACE_DATA_DIR ?? join(dataDir, 'workspace-data'),
  };
}

const nodeOk = () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 15);
};
const portFree = (port, host) =>
  new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, host);
  });
async function apiUp(port, host) {
  try {
    return (await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, ...opts });

function ensureEnvFile() {
  const target = join(root, '.env');
  if (existsSync(target)) return ok('.env already exists (left untouched)');
  copyFileSync(join(root, '.env.example'), target);
  ok('Created .env from .env.example');
}

function buildApi() {
  const r = run(npx, ['tsc', '-b', 'apps/api/tsconfig.json']);
  if (r.status !== 0) throw new Error('Building the API failed. Scroll up for the TypeScript error.');
  ok('API is built');
}

function issueKey(s) {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(keyFile)) return ok(`Dev access key already exists (${keyFile})`);
  const r = spawnSync(npm, ['run', '--silent', 'keys', '-w', '@xo/api', '--', 'issue', 'dev-user', '--kind', 'human', '--dir', s.keys], {
    cwd: root,
    encoding: 'utf8',
    shell: isWin,
  });
  const key = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/xoak_[A-Za-z0-9_-]+/)?.[0];
  if (key === undefined) throw new Error(`Could not create a dev access key.\n${r.stdout}${r.stderr}`);
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  ok(`Created a dev access key (saved to ${keyFile})`);
}

async function setup() {
  step('1/4  Checking tools');
  if (!nodeOk()) throw new Error(`Node 22.15 or newer is required (you have ${process.versions.node}). Install it from nodejs.org.`);
  ok(`Node ${process.versions.node}`);
  step('2/4  Installing packages');
  if (existsSync(join(root, 'node_modules'))) ok('Packages already installed');
  else if (run(npm, ['ci']).status !== 0) throw new Error('npm ci failed.');
  step('3/4  Settings');
  ensureEnvFile();
  step('4/4  Building and creating your dev access key');
  buildApi();
  issueKey(settings(loadEnv()));
  console.log(`\n${c(32, 'All set.')} Next: ${c(1, 'npm run dev')}`);
}

async function doctor() {
  let problems = 0;
  const check = (pass, good, fix) => (pass ? ok(good) : (problems++, bad(fix)));
  const env = loadEnv();
  const s = settings(env);
  check(
    nodeOk(),
    `Node ${process.versions.node} is new enough`,
    `Node ${process.versions.node} is too old: install Node 22.15 or newer from nodejs.org`,
  );
  check(existsSync(join(root, 'node_modules')), 'Packages are installed', 'Packages are missing: run `npm run setup`');
  check(existsSync(join(root, '.env')), '.env exists', '.env is missing: run `npm run setup` (optional, defaults are used without it)');
  check(existsSync(join(root, 'apps/api/dist/index.js')), 'API is built', 'API is not built: run `npm run setup`');
  check(existsSync(keyFile), 'Dev access key exists', 'No dev access key: run `npm run setup`');
  const running = await apiUp(s.apiPort, s.host);
  if (running) ok(`API is running on http://${s.host}:${s.apiPort}`);
  else {
    const free = await portFree(s.apiPort, s.host);
    check(free, `Port ${s.apiPort} is free for the API`, `Port ${s.apiPort} is in use by something else: set PORT in .env`);
    if (free) warn('API is not running (start it with `npm run dev`)');
  }
  if (!running || !(await portFree(s.studioPort, s.host))) {
    if (!(await portFree(s.studioPort, s.host))) warn(`Port ${s.studioPort} is in use (Studio may already be running, or set STUDIO_PORT)`);
  }
  console.log(problems === 0 ? `\n${c(32, 'Everything looks good.')}` : `\n${c(31, `${problems} thing(s) to fix.`)}`);
  process.exitCode = problems === 0 ? 0 : 1;
}

async function dev() {
  const env = loadEnv();
  const s = settings(env);
  if (!nodeOk()) throw new Error(`Node 22.15+ is required (you have ${process.versions.node}).`);
  if (!existsSync(join(root, 'node_modules')) || !existsSync(keyFile)) {
    warn('First run: setting things up…');
    await setup();
  }
  step('Starting XO');
  buildApi();
  if (await apiUp(s.apiPort, s.host)) throw new Error(`An API is already running on port ${s.apiPort}. Stop it, or set PORT in .env.`);
  if (!(await portFree(s.apiPort, s.host))) throw new Error(`Port ${s.apiPort} is in use by something else. Set PORT in .env.`);
  if (!(await portFree(s.studioPort, s.host))) throw new Error(`Port ${s.studioPort} is in use. Set STUDIO_PORT in .env.`);

  const childEnv = {
    ...env,
    PORT: String(s.apiPort),
    HOST: s.host,
    API_KEYS_DIR: s.keys,
    WORKSPACES_DIR: s.workspaces,
    WORKSPACE_DATA_DIR: s.workspaceData,
    XO_API_URL: env.XO_API_URL ?? `http://${s.host}:${s.apiPort}`,
  };
  const kids = [];
  const pipe = (tag, color, child) => {
    const out = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim() !== '') console.log(`${c(color, tag.padEnd(7))}${l}`);
      });
    };
    out(child.stdout);
    out(child.stderr);
    kids.push(child);
    child.on('exit', (code) => {
      if (!stopping) {
        console.log(`\n${c(31, `${tag.trim()} stopped (exit ${code}).`)} Stopping everything.`);
        stop(1);
      }
    });
  };
  let stopping = false;
  const stop = (code = 0) => {
    stopping = true;
    for (const k of kids) k.kill();
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  pipe(
    'api',
    36,
    spawn(process.execPath, ['run-api.mjs'], { cwd: join(root, 'apps/api'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  for (let i = 0; i < 40 && !(await apiUp(s.apiPort, s.host)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await apiUp(s.apiPort, s.host))) {
    bad('The API did not start. Look at the lines above.');
    return stop(1);
  }
  pipe(
    'studio',
    35,
    spawn(npx, ['vite', '--port', String(s.studioPort), '--strictPort'], {
      cwd: join(root, 'apps/studio'),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
    }),
  );

  const key = readFileSync(keyFile, 'utf8').trim();
  setTimeout(() => {
    console.log(
      `\n${c(32, '─'.repeat(58))}\n  Open   ${c(1, `http://localhost:${s.studioPort}`)}\n  Access key (paste into "Development sign-in"):\n         ${c(1, key)}\n  Stop   Ctrl+C\n${c(32, '─'.repeat(58))}\n`,
    );
  }, 1500);
}

const GOOGLE_ISSUER = 'https://accounts.google.com';

/** Desktop app: reads ./.env once, so nothing has to be exported in the shell on every run. */
async function desktop() {
  const env = loadEnv();
  const s = settings(env);
  if (!nodeOk()) throw new Error(`Node 22.15+ is required (you have ${process.versions.node}).`);
  const issuer = (env.XO_OIDC_ISSUER ?? '').trim();
  const clientId = (env.XO_OIDC_CLIENT_ID ?? '').trim();
  if ((issuer === '') !== (clientId === '')) throw new Error('Set XO_OIDC_ISSUER and XO_OIDC_CLIENT_ID together in .env (or neither).');
  if (!existsSync(join(root, 'node_modules')) || !existsSync(keyFile)) {
    warn('First run: setting things up…');
    await setup();
  }
  const apiUrl = env.XO_API_URL ?? `http://${s.host}:${s.apiPort}`;
  const google = issuer === GOOGLE_ISSUER;
  if (issuer !== '' && !google) warn('A non-Google issuer needs its origin added to a dev capability by hand; see docs/studio/DESKTOP.md.');
  const config = google ? 'src-tauri/tauri.dev.google.conf.json' : 'src-tauri/tauri.dev.conf.json';

  step('Starting XO Studio (desktop)');
  const kids = [];
  let stopping = false;
  const stop = (code = 0) => {
    stopping = true;
    for (const k of kids) k.kill();
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  if (await apiUp(s.apiPort, s.host)) {
    ok(`Using the API already running on port ${s.apiPort}`);
    if (google)
      warn(
        'That API was not started by this command: Google sign-in only works if it was started with XO_API_GOOGLE_CLIENT_ID. Stop it and re-run to be sure.',
      );
  } else {
    if (!apiUrl.startsWith(`http://${s.host}:`) && !apiUrl.startsWith('http://127.0.0.1:') && !apiUrl.startsWith('http://localhost:'))
      throw new Error(
        `XO_API_URL (${apiUrl}) is not a local address and nothing answers there. Start that API, or remove XO_API_URL from .env.`,
      );
    buildApi();
    // Google sign-in needs the API to know the same client id Studio uses, plus local folders for sessions and the
    // operator-managed identity bindings. Derived from .env so there is one place to configure; explicit XO_API_* wins.
    const googleApi = {};
    if (google) {
      googleApi.XO_API_GOOGLE_CLIENT_ID = env.XO_API_GOOGLE_CLIENT_ID ?? clientId;
      googleApi.XO_API_SESSIONS_DIR = env.XO_API_SESSIONS_DIR ?? join(dataDir, 'sessions');
      googleApi.XO_API_OIDC_BINDINGS_DIR = env.XO_API_OIDC_BINDINGS_DIR ?? join(dataDir, 'bindings');
      for (const d of [googleApi.XO_API_SESSIONS_DIR, googleApi.XO_API_OIDC_BINDINGS_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    const api = spawn(process.execPath, ['run-api.mjs'], {
      cwd: join(root, 'apps/api'),
      env: {
        ...googleApi,
        ...env,
        PORT: String(s.apiPort),
        HOST: s.host,
        API_KEYS_DIR: s.keys,
        WORKSPACES_DIR: s.workspaces,
        WORKSPACE_DATA_DIR: s.workspaceData,
      },
      stdio: 'inherit',
    });
    kids.push(api);
    api.on('exit', (code) => {
      if (!stopping) {
        console.log(`\n${c(31, `API stopped (exit ${code}).`)}`);
        stop(1);
      }
    });
    for (let i = 0; i < 40 && !(await apiUp(s.apiPort, s.host)); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await apiUp(s.apiPort, s.host))) {
      bad('The API did not start. Look at the lines above.');
      return stop(1);
    }
  }

  const childEnv = { ...env, XO_API_URL: apiUrl };
  if (google) {
    const sessions = env.XO_API_SESSIONS_DIR ?? join(dataDir, 'sessions');
    const bindings = env.XO_API_OIDC_BINDINGS_DIR ?? join(dataDir, 'bindings');
    console.log(
      `\n${c(1, 'Google sign-in is on.')} The first time an account signs in, XO refuses it until you bind it (this is by design). Then run:\n` +
        `  node --import tsx apps/api/scripts/manage-oidc-bindings.ts unbound --sessions-dir "${sessions}"\n` +
        `  node --import tsx apps/api/scripts/manage-oidc-bindings.ts bind --issuer ${GOOGLE_ISSUER} --subject <subject from above> --identity <principal id> --kind human --dir "${bindings}"\n`,
    );
  } else {
    warn('Google sign-in is OFF: add XO_OIDC_ISSUER and XO_OIDC_CLIENT_ID to .env (see .env.example), then re-run.');
  }
  console.log(
    `\n  API      ${apiUrl}\n  Sign-in  ${google ? 'Google (and the development access key)' : 'development access key'}\n  Config   ${config}\n` +
      (existsSync(keyFile)
        ? `  Access key (paste into "Development sign-in"):\n           ${c(1, readFileSync(keyFile, 'utf8').trim())}\n`
        : ''),
  );
  const app = spawn(npx, ['tauri', 'dev', '--config', config], {
    cwd: join(root, 'apps/studio'),
    env: childEnv,
    stdio: 'inherit',
    shell: isWin,
  });
  kids.push(app);
  app.on('exit', (code) => {
    if (!stopping) stop(code ?? 0);
  });
}

async function smoke() {
  const s = settings(loadEnv());
  if (!existsSync(keyFile)) throw new Error('No dev key yet. Run `npm run setup`.');
  if (!(await apiUp(s.apiPort, s.host))) throw new Error('The API is not running. Start it with `npm run dev` in another terminal.');
  const r = run(process.execPath, ['--import', 'tsx', 'scripts/live-smoke.mjs'], {
    cwd: join(root, 'apps/studio'),
    env: { ...process.env, XO_API_URL: `http://${s.host}:${s.apiPort}`, XO_API_KEY: readFileSync(keyFile, 'utf8').trim() },
  });
  process.exitCode = r.status ?? 1;
}

const cmds = { setup, dev, desktop, doctor, smoke };
const cmd = process.argv[2];
if (cmds[cmd] === undefined) {
  console.log('Usage: node scripts/dev.mjs <setup|dev|desktop|doctor|smoke>');
  process.exit(2);
}
cmds[cmd]().catch((e) => {
  console.error(`\n${c(31, 'Problem:')} ${e.message}`);
  process.exit(1);
});
