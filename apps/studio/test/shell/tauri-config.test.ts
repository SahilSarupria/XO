import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTauriConfig } from '../../scripts/check-tauri-config.mjs';

const real = resolve(__dirname, '../../src-tauri');
const dirs: string[] = [];
function copy(): string {
  const d = mkdtempSync(join(tmpdir(), 'tauri-'));
  dirs.push(d);
  cpSync(real, d, { recursive: true, filter: (s) => !s.includes('target') });
  return d;
}
const edit = (root: string, file: string, fn: (j: any) => void) => {
  const p = join(root, file);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  fn(j);
  writeFileSync(p, JSON.stringify(j));
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('committed Tauri configuration', () => {
  it('passes the security-boundary checks', () => {
    expect(checkTauriConfig(real)).toEqual([]);
  });
  it('is NOT release-buildable until a real deploy capability exists (fails closed)', () => {
    const f = checkTauriConfig(real, { release: true });
    expect(f.join('\n')).toMatch(/http-deploy\.json/);
  });
  it('grants the webview no http scope by default, and only its own commands', () => {
    const d = JSON.parse(readFileSync(join(real, 'capabilities/default.json'), 'utf8'));
    const perms: string[] = d.permissions.map((p: any) => (typeof p === 'string' ? p : p.identifier));
    expect(perms.filter((p) => !p.startsWith('allow-'))).toEqual(['core:default']);
  });
});

describe('the checker rejects privilege escalation', () => {
  it.each([
    ['filesystem access', 'fs:default'],
    ['shell execution', 'shell:allow-execute'],
    ['process control', 'process:allow-exit'],
    ['opening arbitrary URLs', 'opener:default'],
    ['dialogs', 'dialog:default'],
  ])('grant of %s', (_n, perm) => {
    const d = copy();
    edit(d, 'capabilities/default.json', (j) => j.permissions.push(perm));
    expect(checkTauriConfig(d).join('\n')).toMatch(/not on the allow-list/);
  });
  it('an app command registered in Rust but missing from the build manifest (would be ungated)', () => {
    const d = copy();
    const p = join(d, 'build.rs');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"login_begin",', ''));
    expect(checkTauriConfig(d).join('\n')).toMatch(/login_begin is registered but not in build\.rs/);
  });
  it('an unregistered/forged command grant', () => {
    const d = copy();
    edit(d, 'capabilities/default.json', (j) => j.permissions.push('allow-delete-everything'));
    expect(checkTauriConfig(d).join('\n')).toMatch(/not an app command/);
  });
  it('http scope with a wildcard host', () => {
    const d = copy();
    edit(d, 'capabilities/http-dev.json', (j) => (j.permissions[0].allow = [{ url: 'https://*/*' }]));
    expect(checkTauriConfig(d).join('\n')).toMatch(/wildcard/);
  });
  it('http scope to plain-http non-loopback, or to a placeholder origin, in a deploy capability', () => {
    const d = copy();
    edit(d, 'capabilities/default.json', () => undefined);
    writeFileSync(
      join(d, 'capabilities/http-deploy.json'),
      JSON.stringify({
        identifier: 'http-deploy',
        windows: ['main'],
        permissions: [
          { identifier: 'http:default', allow: [{ url: 'http://api.corp.local/*' }, { url: 'https://REPLACE-WITH-XO-API-HOST/*' }] },
        ],
      }),
    );
    const f = checkTauriConfig(d, { release: true }).join('\n');
    expect(f).toMatch(/only https/);
    expect(f).toMatch(/placeholder origin/);
  });
  it('a fully configured deploy capability passes release mode', () => {
    const d = copy();
    writeFileSync(
      join(d, 'capabilities/http-deploy.json'),
      JSON.stringify({
        identifier: 'http-deploy',
        windows: ['main'],
        permissions: [
          { identifier: 'http:default', allow: [{ url: 'https://xo.acme-corp.io/*' }, { url: 'https://login.acme-corp.io/*' }] },
        ],
      }),
    );
    expect(checkTauriConfig(d, { release: true })).toEqual([]);
  });
  it('http-dev enabled in the base config would ship dev origins in release', () => {
    const d = copy();
    edit(d, 'tauri.conf.json', (j) => j.app.security.capabilities.push('http-dev'));
    expect(checkTauriConfig(d).join('\n')).toMatch(/http-dev must not be enabled/);
  });
  it('a capability that is not scoped to the main window', () => {
    const d = copy();
    edit(d, 'capabilities/default.json', (j) => (j.windows = ['*']));
    expect(checkTauriConfig(d).join('\n')).toMatch(/window 'main' only/);
  });
  it('remote origins granted IPC access', () => {
    const d = copy();
    edit(d, 'capabilities/default.json', (j) => (j.remote = { urls: ['https://evil.example/*'] }));
    expect(checkTauriConfig(d).join('\n')).toMatch(/remote/);
  });
  it.each([
    [
      'unsafe-inline scripts',
      (c: string) => c.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      /script-src must not allow 'unsafe-inline'/,
    ],
    ['unsafe-eval', (c: string) => c.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), /unsafe-eval/],
    [
      'inline styles',
      (c: string) => c.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
      /style-src must not allow 'unsafe-inline'/,
    ],
    ['a remote script origin', (c: string) => c.replace("script-src 'self'", "script-src 'self' https://cdn.evil.test"), /remote origin/],
    [
      'a direct API origin in connect-src',
      (c: string) => c.replace("connect-src 'self'", "connect-src 'self' https://api.corp.io"),
      /native HTTP plugin/,
    ],
    ['a wildcard', (c: string) => c.replace("img-src 'self' data:", 'img-src *'), /wildcard/],
    [
      'a permissive default-src',
      (c: string) => c.replace("default-src 'self'", "default-src 'self' https:"),
      /default-src must be exactly/,
    ],
  ])('CSP weakened with %s', (_n, mutate, re) => {
    const d = copy();
    edit(d, 'tauri.conf.json', (j) => (j.app.security.csp = mutate(j.app.security.csp)));
    expect(checkTauriConfig(d).join('\n')).toMatch(re);
  });
  it('a null CSP or a loosened dev CSP', () => {
    const a = copy();
    edit(a, 'tauri.conf.json', (j) => (j.app.security.csp = null));
    expect(checkTauriConfig(a).join('\n')).toMatch(/CSP must be set/);
    const b = copy();
    edit(b, 'tauri.conf.json', (j) => (j.app.security.devCsp = 'default-src *'));
    expect(checkTauriConfig(b).join('\n')).toMatch(/devCsp/);
  });
  it('implicitly enabling every capability file', () => {
    const d = copy();
    edit(d, 'tauri.conf.json', (j) => delete j.app.security.capabilities);
    expect(checkTauriConfig(d).join('\n')).toMatch(/list enabled capabilities explicitly/);
  });
});
