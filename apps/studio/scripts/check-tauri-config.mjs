// Static validation of the Tauri security boundary. Runnable without Rust:
//   node scripts/check-tauri-config.mjs [--release] [path/to/src-tauri]
// Default mode checks what is committed. --release additionally requires the deployment
// capability (src-tauri/capabilities/http-deploy.json) to exist with real, non-placeholder origins.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_PERMISSIONS = new Set(['core:default']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const kebab = (s) => s.replace(/_/g, '-');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** @returns {string[]} findings (empty = pass) */
export function checkTauriConfig(root, { release = false } = {}) {
  const f = [];
  const need = (cond, msg) => {
    if (!cond) f.push(msg);
  };
  let conf;
  try {
    conf = readJson(join(root, 'tauri.conf.json'));
  } catch {
    return ['tauri.conf.json is missing or not valid JSON'];
  }

  // ---- CSP
  const csp = conf.app?.security?.csp;
  need(typeof csp === 'string', 'CSP must be set explicitly (a null/absent CSP disables protection)');
  if (typeof csp === 'string') {
    const dirs = Object.fromEntries(
      csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [k, ...v] = d.split(/\s+/);
          return [k, v];
        }),
    );
    need(dirs['default-src']?.join(' ') === "'self'", "CSP default-src must be exactly 'self'");
    need(dirs['object-src']?.join(' ') === "'none'", "CSP object-src must be 'none'");
    for (const [k, v] of Object.entries(dirs)) {
      need(!v.includes("'unsafe-eval'"), `CSP ${k} must not allow 'unsafe-eval'`);
      need(!v.includes('*'), `CSP ${k} must not contain a wildcard`);
      if (k === 'script-src' || k === 'style-src' || k === 'default-src')
        need(!v.includes("'unsafe-inline'"), `CSP ${k} must not allow 'unsafe-inline'`);
      for (const tok of v) {
        if (/^https?:\/\//.test(tok) && k !== 'connect-src') f.push(`CSP ${k} must not allow remote origin ${tok}`);
        if (k === 'connect-src' && /^https?:\/\//.test(tok) && tok !== 'http://ipc.localhost')
          f.push(
            `CSP connect-src must not allow ${tok}: API/IdP traffic goes through the native HTTP plugin and its capability allow-list`,
          );
      }
    }
  }
  need(conf.app?.security?.devCsp === undefined, 'devCsp must not be set (dev must run under the same CSP as release)');
  need(conf.app?.security?.dangerousDisableAssetCspModification !== true, 'dangerousDisableAssetCspModification must not be enabled');
  need(conf.app?.withGlobalTauri !== true, 'withGlobalTauri must not be enabled (exposes the API on window)');
  need(
    !JSON.stringify(conf).includes('assetProtocol') || conf.app?.security?.assetProtocol?.enable !== true,
    'assetProtocol must not be enabled',
  );

  // ---- windows
  const windows = conf.app?.windows ?? [];
  need(
    windows.length === 1 && windows[0].label === 'main',
    "exactly one window labelled 'main' is expected (capabilities are scoped to it)",
  );

  // ---- capabilities
  const capDir = join(root, 'capabilities');
  const capFiles = existsSync(capDir) ? readdirSync(capDir).filter((n) => /\.(json|json5|toml)$/.test(n)) : [];
  const caps = new Map();
  for (const n of capFiles) {
    try {
      const c = readJson(join(capDir, n));
      caps.set(c.identifier, { file: n, ...c });
    } catch {
      f.push(`capabilities/${n} is not valid JSON`);
    }
  }
  const enabled = conf.app?.security?.capabilities;
  need(
    Array.isArray(enabled) && enabled.length > 0,
    'tauri.conf.json must list enabled capabilities explicitly (otherwise every file in capabilities/ is enabled)',
  );

  const commands = new Set();
  const lib = existsSync(join(root, 'src/lib.rs')) ? readFileSync(join(root, 'src/lib.rs'), 'utf8') : '';
  const handler = /generate_handler!\[([^\]]*)\]/s.exec(lib)?.[1] ?? '';
  for (const m of handler.matchAll(/[a-z_][a-z0-9_]*/g)) commands.add(m[0]);
  const build = existsSync(join(root, 'build.rs')) ? readFileSync(join(root, 'build.rs'), 'utf8') : '';
  const manifest = new Set([...(/\.commands\(&\[([^\]]*)\]/s.exec(build)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  need(commands.size > 0, 'no registered commands found in src/lib.rs');
  for (const c of commands) need(manifest.has(c), `command ${c} is registered but not in build.rs (it would be ungated)`);
  for (const c of manifest) need(commands.has(c), `build.rs declares ${c} but it is not registered`);

  const granted = new Set();
  for (const [id, c] of caps) {
    need(
      Array.isArray(c.windows) && c.windows.length === 1 && c.windows[0] === 'main',
      `capability ${id}: must be scoped to window 'main' only`,
    );
    need(c.remote === undefined, `capability ${id}: remote (non-local) origins must not be granted IPC access`);
    need(c.platforms === undefined || Array.isArray(c.platforms), `capability ${id}: platforms must be a list`);
    for (const p of c.permissions ?? []) {
      const ident = typeof p === 'string' ? p : p.identifier;
      if (typeof p === 'string' && ident.startsWith('allow-')) {
        granted.add(ident);
        const cmd = [...commands].find((x) => kebab(x) === ident.slice(6));
        need(cmd !== undefined, `capability ${id}: grants ${ident} which is not an app command`);
        continue;
      }
      if (ident === 'http:default') {
        need(
          typeof p !== 'string' && Array.isArray(p.allow) && p.allow.length > 0,
          `capability ${id}: http:default needs an explicit allow list (default is no scope)`,
        );
        need(typeof p === 'string' || p.deny === undefined || Array.isArray(p.deny), `capability ${id}: invalid deny list`);
        for (const a of typeof p === 'string' ? [] : (p.allow ?? [])) checkHttpScope(f, id, a.url);
        continue;
      }
      need(
        ALLOWED_PERMISSIONS.has(ident),
        `capability ${id}: permission ${ident} is not on the allow-list (fs, shell, process, opener, dialog, os... are forbidden)`,
      );
    }
  }
  const def = caps.get('default');
  need(def !== undefined, "capability 'default' is missing");
  if (def) {
    const g = new Set((def.permissions ?? []).filter((p) => typeof p === 'string'));
    for (const c of commands)
      need(g.has(`allow-${kebab(c)}`), `command ${c} is registered but not granted in capability 'default' (it would be unusable)`);
    need(
      !(def.permissions ?? []).some((p) => (typeof p === 'string' ? p : p.identifier).startsWith('http:')),
      "capability 'default' must not grant http (origin scopes belong in http-dev / http-deploy)",
    );
  }
  for (const id of enabled ?? []) {
    if (!caps.has(id)) need(!release, `enabled capability '${id}' does not exist`);
  }

  // ---- dev / release overlays
  const overlay = (name) => (existsSync(join(root, name)) ? readJson(join(root, name)) : undefined);
  const dev = overlay('tauri.dev.conf.json');
  const rel = overlay('tauri.release.conf.json');
  need(dev !== undefined, 'tauri.dev.conf.json is missing (dev-only origins must not live in the release config)');
  need(rel !== undefined, 'tauri.release.conf.json is missing');
  need(!(enabled ?? []).includes('http-dev'), 'http-dev must not be enabled in the base/release configuration');
  need(
    rel?.app?.security?.capabilities?.includes('http-deploy') === true,
    "release config must enable 'http-deploy' (so a release cannot build without it)",
  );
  need(rel?.app?.security?.capabilities?.includes('http-dev') !== true, 'release config must not enable http-dev');
  need(dev?.app?.security?.devCsp === undefined, 'dev config must not weaken the CSP');
  if (caps.has('http-dev')) {
    for (const p of caps.get('http-dev').permissions ?? [])
      for (const a of p.allow ?? []) {
        try {
          need(LOOPBACK.has(new URL(a.url.replace('*', 'x')).hostname), `http-dev may only allow loopback origins (found ${a.url})`);
        } catch {
          f.push(`http-dev: invalid url ${a.url}`);
        }
      }
  }
  // Opt-in dev capability for Google sign-in: exactly Google's OIDC discovery origin, nothing else. The token exchange runs
  // on the XO API (which holds the client secret), so Studio needs no Google token or revocation origin.
  if (caps.has('http-dev-google')) {
    const allowed = new Set(['https://accounts.google.com/*']);
    for (const p of caps.get('http-dev-google').permissions ?? [])
      for (const a of p.allow ?? []) need(allowed.has(a.url), `http-dev-google may only allow Google's sign-in origins (found ${a.url})`);
  }
  need(!(enabled ?? []).includes('http-dev-google'), 'http-dev-google must not be enabled in the base/release configuration');
  need(rel?.app?.security?.capabilities?.includes('http-dev-google') !== true, 'release config must not enable http-dev-google');
  const devGoogle = overlay('tauri.dev.google.conf.json');
  need(devGoogle?.app?.security?.devCsp === undefined, 'dev Google config must not weaken the CSP');
  if (release)
    need(
      caps.has('http-deploy'),
      'release build requires src-tauri/capabilities/http-deploy.json (copy deploy/http-deploy.capability.example.json and set your real origins)',
    );
  return f;
}

function checkHttpScope(f, id, url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(String(url));
  if (m === null) {
    f.push(`capability ${id}: invalid http scope ${url}`);
    return;
  }
  if (m[2].includes('*') || m[2] === '') {
    f.push(`capability ${id}: wildcard or empty hosts are forbidden (${url})`);
    return;
  }
  let u;
  try {
    u = new URL(String(url).replace(/\*/g, 'x'));
  } catch {
    f.push(`capability ${id}: invalid http scope ${url}`);
    return;
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname)))
    f.push(`capability ${id}: only https (or loopback http) is allowed (${url})`);
  if (/REPLACE|example\.(com|org|net)|\.test$|\.invalid$/i.test(u.hostname) || /REPLACE/.test(String(url)))
    f.push(`capability ${id}: placeholder origin ${url} must be replaced with a real configured origin`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const release = args.includes('--release');
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? fileURLToPath(new URL('../src-tauri', import.meta.url)));
  const findings = checkTauriConfig(root, { release });
  if (findings.length === 0) console.log(`Tauri config OK (${release ? 'release' : 'development'} mode): ${root}`);
  else {
    console.error(`Tauri config FAILED (${findings.length}):\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
}
