import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSettings, parseEnvFile, renderConfigurationReference, resolveSettings, SETTINGS } from '../src/settings.js';

// Package trust must be decided explicitly; these tests are about other settings, so they decide it once here.
const resolve = (env: Record<string, string>, extra: Partial<Parameters<typeof resolveSettings>[1]> = {}) =>
  resolveSettings({ XO_TRUST_MODE: 'development', ...env }, { joinPath: (...p) => p.join('/'), ...extra });

test('every problem is reported at once, with the value and the rule it broke', () => {
  const r = resolve({ PORT: '99999', XO_OCR: 'cloud', XO_API_SELF_SIGNUP: 'yes', XO_PUBLIC_BASE_URL: 'http://xo.example.com' });
  assert.deepEqual(r.errors.map((e) => e.name).sort(), ['PORT', 'XO_API_SELF_SIGNUP', 'XO_OCR', 'XO_PUBLIC_BASE_URL']);
  assert.match(
    r.errors.find((e) => e.name === 'XO_API_SELF_SIGNUP')!.message,
    /must be one of: 1, true, 0, false \(got "yes"\)/,
    'a value a feature would silently read as off is refused',
  );
  assert.match(r.errors.find((e) => e.name === 'XO_PUBLIC_BASE_URL')!.message, /must be https/);
  assert.equal(resolve({ XO_PUBLIC_BASE_URL: 'http://127.0.0.1:4000' }).errors.length, 0, 'plain http is fine on loopback');
});

test('a misspelt setting is reported with the closest real one; tools settings and secret families are not', () => {
  const r = resolve({
    XO_OCR_WORKER: '2',
    XO_STEP_UP_MAX_AGE_MINUTES: '5',
    XO_HOME: '/h',
    XO_SECRET_SMTP: 'x',
    XO_ZZZZZZZZZZZZZ: '1',
    HOME: '/root',
  });
  const w = Object.fromEntries(r.warnings.map((x) => [x.name, x.message]));
  assert.match(w['XO_OCR_WORKER']!, /did you mean XO_OCR_WORKERS\?/);
  assert.match(w['XO_STEP_UP_MAX_AGE_MINUTES']!, /did you mean XO_API_STEP_UP_MAX_AGE_MINUTES\?/);
  assert.match(w['XO_ZZZZZZZZZZZZZ']!, /is not an XO setting; it is ignored/);
  assert.equal(w['XO_HOME'], undefined);
  assert.equal(w['XO_SECRET_SMTP'], undefined);
  assert.equal(w['HOME'], undefined, 'only XO-looking names are checked');
});

test('XO_DATA_DIR puts every storage setting inside one folder; explicit values and features that are off are left alone', () => {
  const r = resolve({ XO_DATA_DIR: '/srv/xo', WORKSPACES_DIR: '/elsewhere/ws' });
  assert.equal(r.env['API_KEYS_DIR'], '/srv/xo/api-keys');
  assert.equal(r.env['WORKSPACE_DATA_DIR'], '/srv/xo/workspace-data');
  assert.equal(r.env['XO_SECRETS_FILE'], '/srv/xo/secrets.enc');
  assert.equal(r.env['WORKSPACES_DIR'], '/elsewhere/ws');
  assert.equal(r.sources['API_KEYS_DIR'], 'data-dir');
  assert.equal(r.env['XO_AUDIT_DIR'], undefined, 'platform audit stays off until its retention is set');
  assert.equal(r.env['XO_API_PASSWORD_BINDINGS_DIR'], undefined, 'password sign-in stays off');
  const on = resolve({ XO_DATA_DIR: '/srv/xo', XO_AUDIT_RETENTION_DAYS: '400', XO_AUDIT_MIN_RETENTION_DAYS: '365' });
  assert.equal(on.env['XO_AUDIT_DIR'], '/srv/xo/audit');
  assert.equal(on.errors.length, 0);
});

test('cross-setting rules: half-set audit, anchors or the secrets key inside the data dir, development trust in production', () => {
  const r = resolve({
    XO_DATA_DIR: '/srv/xo',
    XO_AUDIT_RETENTION_DAYS: '400',
    XO_AUDIT_ANCHOR_DIR: '/srv/xo/anchors',
    XO_SECRETS_KEY_FILE: '/srv/xo/key',
    XO_ENV: 'production',
    XO_TRUST_MODE: 'development',
  });
  assert.deepEqual(r.errors.map((e) => e.name).sort(), ['XO_AUDIT_ANCHOR_DIR', 'XO_AUDIT_DIR', 'XO_SECRETS_KEY_FILE', 'XO_TRUST_MODE']);
});

test('the environment wins over the config file, which wins over secrets; secrets in plain text are flagged; values are never echoed for secrets', () => {
  const r = resolve(
    { PORT: '5000' },
    {
      configFile: {
        path: '/srv/xo/xo.env',
        text: '# settings\nPORT=6000\nHOST=0.0.0.0\nANTHROPIC_API_KEY="sk-plain"\nexport XO_OCR=off\n',
      },
      secrets: { ANTHROPIC_API_KEY: 'sk-secret', GEMINI_API_KEY: 'g-secret', PORT: '1' },
    },
  );
  assert.equal(r.env['PORT'], '5000');
  assert.equal(r.env['HOST'], '0.0.0.0');
  assert.equal(r.env['XO_OCR'], 'off');
  assert.equal(r.env['ANTHROPIC_API_KEY'], 'sk-plain');
  assert.equal(r.env['GEMINI_API_KEY'], 'g-secret');
  assert.equal(r.sources['GEMINI_API_KEY'], 'secrets');
  assert.ok(r.warnings.some((w) => w.name === 'ANTHROPIC_API_KEY' && /plain text/.test(w.message)));
  assert.ok(r.warnings.some((w) => w.name === 'PORT' && /not a secret setting/.test(w.message)));
  const bad = resolve({ GEMINI_API_KEY: 'abc\n' });
  assert.equal(bad.errors.length, 1);
  assert.doesNotMatch(bad.errors[0]!.message, /abc/, 'a secret value is never echoed');
  const described = describeSettings(r);
  assert.equal(described.find((d) => d.name === 'GEMINI_API_KEY')!.value, '(set, hidden)');
  assert.equal(described.find((d) => d.name === 'PORT')!.source, 'environment');
});

test('env files: comments, quotes, export, duplicates and malformed lines', () => {
  const p = parseEnvFile('A=1\n  # c\nB="two words"\nC=3 # trailing\nexport D=4\nA=5\nnot a line\n');
  assert.deepEqual(p.values, { A: '5', B: 'two words', C: '3', D: '4' });
  assert.deepEqual(p.problems, ['line 6: A is set twice; the later value is used', 'line 7 is not KEY=VALUE']);
});

test('every environment variable the instance code reads is in the registry (no setting can be added without being documented)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const known = new Set(SETTINGS.map((s) => s.name));
  const out = execFileSync(
    'grep',
    [
      '-rhoE',
      String.raw`(process\.env|env)(\[['"]|\.)[A-Z][A-Z0-9_]+`,
      'apps/api/src',
      'packages',
      '--include=*.ts',
      '--exclude-dir=test',
      '--exclude-dir=node_modules',
      '--exclude-dir=dist',
      '--exclude-dir=scripts',
      // Evaluation suites are development tooling (packages/evaluation/suites), not instance code.
      '--exclude-dir=suites',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const read = new Set(
    out
      .split('\n')
      .map((l) => l.replace(/^(process\.env|env)(\[['"]|\.)/, ''))
      .filter((n) => n !== '' && !['PATH', 'HOME', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'GOOGLE_API_KEY'].includes(n)),
  );
  const missing = [...read].filter((n) => !known.has(n) && !n.startsWith('XO_SECRET_'));
  assert.deepEqual(missing, [], `read by code but not registered in packages/instance/src/settings.ts: ${missing.join(', ')}`);
});

test('docs/CONFIGURATION.md is the generated reference (regenerate with the script when settings change)', () => {
  const doc = readFileSync(join(fileURLToPath(new URL('../../../', import.meta.url)), 'docs/CONFIGURATION.md'), 'utf8');
  assert.equal(doc, renderConfigurationReference());
});

test('an empty value means unset, as everywhere in XO: not checked, and filled from the data directory', () => {
  const r = resolve({ XO_DATA_DIR: '/srv/xo', XO_API_OIDC_ISSUER: '', API_KEYS_DIR: '', PORT: ' ' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.env['API_KEYS_DIR'], '/srv/xo/api-keys');
});

test('a value that may carry a credential (a URL, a string) is never echoed in a problem', () => {
  const r = resolve({ XO_API_OIDC_ISSUER: 'https://user:hunter2@idp.example', XO_OCR_VISION_MODEL: 'x\u0001' });
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.every((e) => !e.message.includes('hunter2') && !e.message.includes('got')));
});

test('production and package trust are checked before anything is written: durable audit and a trust decision are required', () => {
  const prod = resolveSettings({ NODE_ENV: 'production', XO_DATA_DIR: '/srv/xo' }, { joinPath: (...p) => p.join('/') });
  assert.deepEqual(prod.errors.map((e) => e.name).sort(), ['XO_AUDIT_RETENTION_DAYS', 'XO_PACKAGE_TRUST_POLICY']);
  const ok = resolveSettings(
    {
      NODE_ENV: 'production',
      XO_DATA_DIR: '/srv/xo',
      XO_AUDIT_RETENTION_DAYS: '400',
      XO_AUDIT_MIN_RETENTION_DAYS: '365',
      XO_PACKAGE_TRUST_POLICY: '/etc/xo/trust.json',
    },
    { joinPath: (...p) => p.join('/') },
  );
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.env['XO_AUDIT_DIR'], '/srv/xo/audit');
});
