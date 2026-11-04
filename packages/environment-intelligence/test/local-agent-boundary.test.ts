/**
 * C2 - the agent's trust boundary and wire protocol, tested without any connector: socket location rules (private directory, owner,
 * modes, symlinks, ancestors, stale and live sockets), the client-side re-verification, the frame decoder, the closed request schema,
 * the Linux-only isolation, and a source-level guard that the agent contains no exec and no network listener.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EnvironmentInventory,
  EvidenceLedger,
  FrameDecoder,
  InMemoryAuditRecorder,
  LocalAgent,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_PATH_BYTES,
  callAgent,
  checkSocketFile,
  encodeFrame,
  ensurePrivateDirectory,
  FailClosedAuthorization,
  parseRequest,
  removeStaleSocket,
  requireLinux,
  validateSocketPath,
  verifySocketForConnect,
  type LocalAgentOptions,
} from '../src/index.js';
import { withSandbox } from './helpers.js';
import { rawExchange, withAgentEnv } from './support/agent-env.js';

const T = { timeout: 30_000, skip: process.platform !== 'linux' } as const;
const euid = process.geteuid?.() ?? -1;

function agentOptions(socketDir: string, extra: Partial<LocalAgentOptions> = {}): LocalAgentOptions {
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  return {
    socketDir,
    deps: { registry: new ConnectorRegistry(), inventory: new EnvironmentInventory() },
    clock,
    authorization: new FailClosedAuthorization(),
    audit: new InMemoryAuditRecorder(() => clock.now()),
    ledger: new EvidenceLedger(),
    ...extra,
  };
}

const reason = (r: { ok: boolean; error?: { context: Readonly<Record<string, unknown>> } }): unknown =>
  r.ok ? undefined : r.error?.context['reason'];

// ── socket location ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('a started agent is private: directory 0700, socket 0600, both owned by the agent uid', T, async () => {
  await withAgentEnv({}, async (env) => {
    const dir = await lstat(env.socketDir);
    const sock = await lstat(env.socketPath);
    assert.equal(dir.mode & 0o777, 0o700);
    assert.equal(sock.mode & 0o777, 0o600);
    assert.ok(sock.isSocket());
    assert.equal(dir.uid, euid);
    assert.equal(sock.uid, euid);
  });
});

test('start refuses a socket location that is not trusted', T, async () => {
  await withSandbox(async ({ base }) => {
    // shared (group/other accessible) directory
    const shared = join(base, 'shared');
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const a = await LocalAgent.start(agentOptions(shared));
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.error.context['reason'], 'dir_not_private');

    // a symlink in place of the directory
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(base, 'link'));
    const b = await LocalAgent.start(agentOptions(join(base, 'link')));
    assert.equal(b.ok, false);

    // an ancestor other users can write to (no sticky bit) could let them rename the directory away
    const loose = join(base, 'loose');
    await mkdir(loose);
    await chmod(loose, 0o777);
    const c = await LocalAgent.start(agentOptions(join(loose, 'sock')));
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.error.context['reason'], 'ancestor_writable');

    // something that is not a socket already sits at the socket path
    const dir = join(base, 'occupied');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'agent.sock'), 'not a socket');
    const d = await LocalAgent.start(agentOptions(dir));
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.error.context['reason'], 'not_a_socket');
    assert.equal(await readFile(join(dir, 'agent.sock'), 'utf8'), 'not a socket', 'a foreign file is never deleted');

    // relative, non-normalized and over-long paths
    for (const bad of ['relative/dir', `${base}/a/../b`, join(base, 'x'.repeat(MAX_SOCKET_PATH_BYTES))]) {
      const r = await LocalAgent.start(agentOptions(bad));
      assert.equal(r.ok, false, bad.slice(0, 30));
    }
  });
});

test('ownership is enforced: a directory or socket owned by another uid is refused', T, async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'mine');
    await mkdir(dir, { mode: 0o700 });
    assert.equal((await ensurePrivateDirectory(dir)).ok, true);
    const other = await ensurePrivateDirectory(dir, { uid: euid + 1 });
    assert.equal(other.ok, false);
    assert.equal(reason(other), 'dir_wrong_owner');
  });
  await withAgentEnv({}, async (env) => {
    assert.equal((await checkSocketFile(env.socketPath)).ok, true);
    const other = await checkSocketFile(env.socketPath, { uid: euid + 1 });
    assert.equal(other.ok, false);
    assert.equal(reason(other), 'socket_wrong_owner');
  });
});

test('a second agent never steals a live socket', T, async () => {
  await withAgentEnv({}, async (env) => {
    const second = await LocalAgent.start(agentOptions(env.socketDir));
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.context['reason'], 'agent_already_running');
    assert.equal((await env.discover()).ok, true, 'the first agent is intact and still serving');
  });
});

test('a stale socket file left by a killed process is cleaned up and the agent starts', T, async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'sock');
    await mkdir(dir, { mode: 0o700 });
    const path = join(dir, 'agent.sock');
    try {
      execFileSync(
        process.execPath,
        ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`],
        {
          stdio: 'ignore',
        },
      );
    } catch {
      /* the child kills itself */
    }
    assert.ok((await lstat(path)).isSocket(), 'a stale socket exists');
    const started = await LocalAgent.start(agentOptions(dir));
    assert.ok(started.ok, `the stale socket was replaced: ${JSON.stringify(started.ok ? '' : started.error)}`);
    if (started.ok) await started.value.stop();
  });
});

test('a symlink anywhere in the path to the socket directory is refused, not just at its leaf', T, async () => {
  await withSandbox(async ({ base }) => {
    await mkdir(join(base, 'real'), { mode: 0o700 });
    await symlink(join(base, 'real'), join(base, 'via'));
    const r = await ensurePrivateDirectory(join(base, 'via', 'sock'), { create: true });
    assert.equal(r.ok, false);
    assert.equal(reason(r), 'path_contains_symlink');
  });
});

test(
  'an ancestor owned by a different non-root user is refused (needs root to arrange)',
  { timeout: 30_000, skip: process.platform !== 'linux' || euid !== 0 },
  async () => {
    await withSandbox(async ({ base }) => {
      const owned = join(base, 'owned');
      await mkdir(owned, { mode: 0o755 });
      await chown(owned, 4242, 4242);
      await chmod(owned, 0o755);
      const r = await ensurePrivateDirectory(join(owned, 'sock'), { create: true });
      assert.equal(r.ok, false);
      assert.equal(reason(r), 'ancestor_wrong_owner');
    });
  },
);

test('stale-socket removal deletes only a socket this uid owns', T, async () => {
  await withAgentEnv({}, async (env) => {
    await env.agent.stop();
    // `stop` removed the file; recreate a dead socket the same way a crash would leave it
    try {
      execFileSync(
        process.execPath,
        ['-e', `require('net').createServer().listen(${JSON.stringify(env.socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`],
        { stdio: 'ignore' },
      );
    } catch {
      /* the child kills itself */
    }
    const foreign = await removeStaleSocket(env.socketPath, { uid: euid + 1 });
    assert.equal(foreign.ok, false);
    assert.equal(reason(foreign), 'socket_wrong_owner');
    assert.ok((await lstat(env.socketPath)).isSocket(), 'a socket owned by someone else is left alone');
    assert.equal((await removeStaleSocket(env.socketPath)).ok, true);
  });
});

test('the connection limit is enforced: a third connection is dropped while two are held', T, async () => {
  await withAgentEnv({ agent: { maxConnections: 2 } }, async (env) => {
    const held = [connect(env.socketPath), connect(env.socketPath)];
    await new Promise((done) => setTimeout(done, 150));
    const third = await rawExchange(env.socketPath, undefined, 300, true);
    assert.equal(third.closed, true);
    for (const s of held) s.destroy();
  });
});

// ── the client re-verifies before connecting ──────────────────────────────────────────────────────────────────────────────

test('the client refuses a socket whose directory or file is not private, and a path that is not a socket', T, async () => {
  await withAgentEnv({}, async (env) => {
    await chmod(env.socketPath, 0o666);
    let r = await callAgent(env.socketPath, { op: 'discover', scope: { kind: 'filesystem_root', root: env.root } });
    assert.equal(r.ok, false);
    assert.equal(reason(r), 'socket_not_private');
    await chmod(env.socketPath, 0o600);

    await chmod(env.socketDir, 0o755);
    r = await callAgent(env.socketPath, { op: 'discover', scope: { kind: 'filesystem_root', root: env.root } });
    assert.equal(reason(r), 'dir_not_private');
    await chmod(env.socketDir, 0o700);

    const plain = join(env.base, 'plain');
    await writeFile(plain, 'x');
    r = await callAgent(plain, { op: 'discover', scope: { kind: 'filesystem_root', root: env.root } });
    assert.equal(r.ok, false);
    assert.equal(reason(r), 'not_a_socket');
    assert.equal((await verifySocketForConnect(join(env.base, 'missing', 'agent.sock'))).ok, false);
  });
});

// ── platform ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('Linux only: other platforms are refused outright, with no claim of support', async () => {
  for (const platform of ['win32', 'darwin', 'freebsd'] as const) {
    const r = requireLinux(platform);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
  }
  assert.equal(requireLinux('linux').ok, true);
});

test('invalid agent options and an invalid principal id fail before anything is bound', T, async () => {
  await withSandbox(async ({ base }) => {
    for (const extra of [
      { requestTimeoutMs: 0 },
      { requestTimeoutMs: 10 ** 9 },
      { maxConnections: -1 },
      { idempotencyCacheSize: 1.5 },
      { principalId: 'has space' },
    ]) {
      const r = await LocalAgent.start(agentOptions(join(base, 'sock'), extra));
      assert.equal(r.ok, false, JSON.stringify(extra));
      if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
    }
    await assert.rejects(lstat(join(base, 'sock')), 'nothing was created for a rejected configuration');
  });
});

// ── wire protocol ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the frame decoder reassembles split and coalesced frames and enforces the cap from the header alone', () => {
  const a = encodeFrame(Buffer.from('{"a":1}'));
  const b = encodeFrame(Buffer.from('{"b":2}'));
  const d = new FrameDecoder(MAX_REQUEST_BYTES);
  const whole = Buffer.concat([a, b]);
  const out: string[] = [];
  for (let i = 0; i < whole.length; i += 3) {
    const r = d.push(whole.subarray(i, i + 3));
    assert.equal(r.ok, true);
    if (r.ok) for (const f of r.frames) out.push(f.toString());
  }
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
  assert.equal(d.pending, false);

  const big = new FrameDecoder(16);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(17);
  assert.deepEqual(big.push(header), { ok: false, reason: 'too_large' });
  assert.deepEqual(new FrameDecoder(16).push(Buffer.alloc(4)), { ok: false, reason: 'empty' });
});

test('the request schema is closed: exactly the documented fields, nothing else', () => {
  const root = '/srv/data';
  const discover = { v: 1, id: 'req-00000001', op: 'discover', scope: { kind: 'filesystem_root', root } };
  assert.equal(parseRequest(discover).ok, true);
  assert.equal(parseRequest({ ...discover, extra: 1 }).ok, false);
  assert.equal(parseRequest({ ...discover, scope: { ...discover.scope, extra: 1 } }).ok, false);
  const acquire = { v: 1, id: 'req-00000002', op: 'acquire', sourceId: 'src_abc', scope: discover.scope, resourceKeys: ['a.txt'] };
  assert.equal(parseRequest(acquire).ok, true);
  for (const extra of ['principal', 'limits', 'kind', 'command', '__proto__'])
    assert.equal(parseRequest({ ...acquire, [extra]: {} }).ok, false, extra);
  assert.equal(parseRequest({ v: 1, op: 'cancel', id: 'req-00000003' }).ok, true);
  assert.equal(parseRequest({ v: 1, op: 'cancel', id: 'req-00000003', x: 1 }).ok, false);
  assert.equal(
    parseRequest(
      JSON.parse(
        '{"__proto__":{"op":"discover"},"v":1,"id":"req-00000004","op":"discover","scope":{"kind":"filesystem_root","root":"/a"}}',
      ),
    ).ok,
    false,
  );
  assert.equal(validateSocketPath('/tmp/ok.sock').ok, true);
});

// ── no exec, no network ───────────────────────────────────────────────────────────────────────────────────────────────────

test('the agent source contains no process execution, no network listener and no dynamic code', async () => {
  const dir = join(import.meta.dirname, '..', 'src', 'agent');
  const forbidden = [
    /child_process/,
    /node:(http|https|http2|dgram|tls|dns|vm|worker_threads|cluster)\b/,
    /\b(spawn|execFile|execSync|exec|fork)\s*\(/,
    /\beval\s*\(/,
    /new Function\b/,
    /\.listen\(\s*\d/,
    /\bprocess\.env\b/,
    /console\./,
  ];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = (await readFile(join(dir, f), 'utf8'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    for (const re of forbidden) assert.ok(!re.test(text), `${f} must not match ${re}`);
  }
});
