import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfinementUnavailableError, confinementRecord, mcpConnector, planConfinement, type Probe } from '../src/index.js';

const only =
  (...ok: string[]): Probe =>
  (cmd) =>
    ok.includes(cmd);

describe('confinement planning (injected host)', () => {
  it('prefers bubblewrap, builds an allow-list root, and keeps the network off by default', () => {
    const p = planConfinement(
      { readOnlyPaths: ['/opt/srv'], writablePaths: ['/var/srv-data'] },
      { platform: 'linux', probe: only('bwrap', 'unshare') },
    );
    assert.equal(p.kind, 'bwrap');
    assert.ok(p.prefix.includes('--unshare-all') && !p.prefix.includes('--share-net'));
    assert.deepEqual(p.prefix.slice(p.prefix.indexOf('/opt/srv') - 1, p.prefix.indexOf('/opt/srv') + 2), [
      '--ro-bind',
      '/opt/srv',
      '/opt/srv',
    ]);
    assert.ok(p.prefix.join(' ').includes('--bind /var/srv-data /var/srv-data'));
    assert.equal(p.prefix.at(-1), '--');
    assert.equal(planConfinement({ network: 'host' }, { platform: 'linux', probe: only('bwrap') }).prefix.includes('--share-net'), true);
    assert.equal(p.operatorOptOut, false);
  });
  it('on a host with only namespaces it refuses by default and, when told to accept, says plainly that files are NOT confined', () => {
    const probe = only('unshare');
    assert.throws(() => planConfinement({}, { platform: 'linux', probe }), ConfinementUnavailableError);
    const p = planConfinement({ require: 'namespaces' }, { platform: 'linux', probe });
    assert.equal(p.kind, 'namespaces');
    assert.match(p.notProtected.join('\n'), /read every file this user can read/);
    assert.ok(p.prefix.includes('-n') && p.prefix.includes('--kill-child'));
  });
  it('other platforms and bare hosts refuse unless the operator opts in; the opt-in is recorded with the reason and what is unprotected', () => {
    for (const platform of ['darwin', 'win32']) {
      assert.throws(() => planConfinement({}, { platform, probe: () => true }), /Linux only|cannot confine/);
      const p = planConfinement({ allowUnconfined: true }, { platform, probe: () => true });
      assert.equal(p.kind, 'none');
      assert.equal(p.operatorOptOut, true);
      assert.match(p.notProtected.join('\n'), /read and write whatever that user can/);
      const rec = confinementRecord(p);
      assert.equal(rec['operatorOptOut'], true);
      assert.match(String(rec['reason']), new RegExp(platform));
    }
    assert.throws(() => planConfinement({}, { platform: 'linux', probe: () => false }), /neither bubblewrap nor/);
    const off = planConfinement({ disable: true }, { platform: 'linux', probe: only('bwrap') });
    assert.equal(off.kind, 'none');
    assert.equal(off.operatorOptOut, true);
  });
  it('an operator wrapper is used as given but claims nothing', () => {
    const p = planConfinement({ operatorWrapper: ['firejail', '--net=none'] }, { platform: 'darwin' });
    assert.equal(p.kind, 'operator-wrapper');
    assert.deepEqual(p.protects, []);
    assert.deepEqual(p.prefix, ['firejail', '--net=none']);
    assert.throws(() => planConfinement({ operatorWrapper: [] }), /not be empty/);
  });
  it('adversarial paths: relative, traversal, root, newline and NUL are refused before any command is built', () => {
    const probe = only('bwrap');
    for (const bad of ['rel/path', '/a/../etc', '/', '//', '/a\nb', '/a\0b', '']) {
      assert.throws(
        () => planConfinement({ readOnlyPaths: [bad] }, { platform: 'linux', probe }),
        ConfinementUnavailableError,
        JSON.stringify(bad),
      );
      assert.throws(
        () => planConfinement({ writablePaths: [bad] }, { platform: 'linux', probe }),
        ConfinementUnavailableError,
        JSON.stringify(bad),
      );
    }
  });
  it('an MCP stdio connector with no plan refuses to be built (there is no unconfined default)', () => {
    assert.throws(
      () =>
        mcpConnector(
          { server: { transport: 'stdio', command: 'x' } as never, tools: {}, maxResponseBytes: 10 },
          { secret: () => undefined },
        ),
      /confinement plan/,
    );
  });
});

const real = {
  namespaces: spawnSync('unshare', ['-r', '-p', '-f', '-i', '-u', '-n', '--kill-child', 'true'], { stdio: 'ignore' }).status === 0,
  bwrap:
    spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'], {
      stdio: 'ignore',
    }).status === 0,
};
const skip = (ok: boolean, what: string): string | false =>
  ok ? false : `skipped: ${what} cannot run on this host (adversarial confinement tests need it)`;

/** A hostile "server": tries the network, signalling a host process, reading a secret file and the environment. Prints one JSON line. */
const HOSTILE = `
const net = require('node:net'), fs = require('node:fs');
const [port, hostPid, secret] = process.argv.slice(1);
const out = { env: Object.keys(process.env).filter((k) => k !== 'PATH').length };
try { process.kill(Number(hostPid), 0); out.signalled = true; } catch { out.signalled = false; }
try { out.secret = fs.readFileSync(secret, 'utf8'); } catch { out.secret = null; }
const s = net.connect({ host: '127.0.0.1', port: Number(port) });
s.on('connect', () => { out.net = true; done(); });
s.on('error', () => { out.net = false; done(); });
setTimeout(done, 2000);
let finished = false;
function done() { if (finished) return; finished = true; s.destroy(); process.stdout.write(JSON.stringify(out) + '\\n'); }
`;

async function runHostile(prefix: readonly string[], extra: string[] = []): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'xo-confine-'));
  const secretFile = join(dir, 'secret.txt');
  writeFileSync(secretFile, 'TOP-SECRET');
  const srv = createServer((c) => c.end());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const argv = [...prefix, process.execPath, '-e', HOSTILE, String(port), String(process.pid), secretFile, ...extra];
    const r = spawnSync(argv[0] as string, argv.slice(1), { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8', timeout: 15000 });
    return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
  } finally {
    srv.close();
  }
}

describe('confinement, adversarially, on the real host', () => {
  it('control: unconfined, the hostile child reaches the network, a host process and the secret file (so the tests below mean something)', async () => {
    const o = await runHostile([]);
    assert.deepEqual([o['net'], o['signalled'], o['secret']], [true, true, 'TOP-SECRET']);
  });
  it(
    'namespaces: the child has no network and cannot see or signal host processes; it CAN still read files (documented, asserted)',
    { skip: skip(real.namespaces, 'unshare') },
    async () => {
      const plan = planConfinement({ require: 'namespaces' }, { platform: 'linux', probe: only('unshare') });
      const o = await runHostile(plan.prefix);
      assert.equal(o['net'], false, 'network reachable from the namespace');
      assert.equal(o['signalled'], false, 'host process was signalled');
      assert.equal(o['env'], 0);
      assert.equal(o['secret'], 'TOP-SECRET', 'if this starts failing, the docs claim "files not confined" is stale');
    },
  );
  it(
    'bubblewrap: no network, no host processes, and the secret file does not exist for the child',
    { skip: skip(real.bwrap, 'bubblewrap') },
    async () => {
      const plan = planConfinement({ readOnlyPaths: [process.execPath.replace(/\/bin\/node$/, '')] }, { platform: 'linux' });
      assert.equal(plan.kind, 'bwrap');
      const o = await runHostile(plan.prefix);
      assert.equal(o['net'], false);
      assert.equal(o['signalled'], false);
      assert.equal(o['secret'], null);
    },
  );
});
