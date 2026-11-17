// UW-12a part 2: `xo agent install` starts the agent at sign-in on macOS, Linux and Windows, without administrator rights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { installService, serviceDefinition, uninstallService, type Runner, type ServiceContext } from '../src/commands/agent/service.js';
import { ignoredChange } from '../src/commands/agent/loop.js';
import { withTempDir } from './helpers.js';

const ctx = (platform: NodeJS.Platform, home: string): ServiceContext => ({
  platform,
  home,
  node: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node',
  cli: platform === 'win32' ? 'C:\\Users\\Asha Rao\\xo\\cli.js' : '/opt/xo 100%/cli.js',
  config: platform === 'win32' ? 'C:\\Users\\Asha Rao\\.xo\\agent.json' : `${home}/.xo/agent.json`,
  uid: 501,
  appData: 'C:\\Users\\Asha Rao\\AppData\\Roaming',
});

test('macOS: a LaunchAgent that starts at login, restarts after a crash but not after a clean stop', () => {
  const d = serviceDefinition(ctx('darwin', '/Users/asha'));
  assert.equal(d.file, '/Users/asha/Library/LaunchAgents/com.xo.agent.plist');
  assert.match(d.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(d.content, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(
    d.content,
    /<string>\/opt\/xo 100%\/cli\.js<\/string>\s*<string>agent<\/string>\s*<string>run<\/string>\s*<string>--service<\/string>/,
  );
  assert.deepEqual(d.start, [
    ['launchctl', 'bootout', 'gui/501/com.xo.agent'],
    ['launchctl', 'bootstrap', 'gui/501', '/Users/asha/Library/LaunchAgents/com.xo.agent.plist'],
  ]);
  assert.equal(d.log, '/Users/asha/.xo/agent.log');
});

test('Linux: a systemd user unit wanted by default.target; paths with spaces and % are quoted and escaped', () => {
  const d = serviceDefinition(ctx('linux', '/home/asha'));
  assert.equal(d.file, '/home/asha/.config/systemd/user/xo-agent.service');
  assert.match(
    d.content,
    /^ExecStart="\/usr\/local\/bin\/node" "\/opt\/xo 100%%\/cli\.js" "agent" "run" "--service" "--config" "\/home\/asha\/\.xo\/agent\.json"$/m,
  );
  assert.match(d.content, /^Restart=on-failure$/m);
  assert.match(d.content, /^WantedBy=default\.target$/m);
  assert.deepEqual(d.start.slice(-2), [
    ['systemctl', '--user', 'enable', '--now', 'xo-agent.service'],
    ['loginctl', 'enable-linger'],
  ]);
});

test('Windows: a hidden script in the per-user Startup folder, with every argument quoted', () => {
  const d = serviceDefinition(ctx('win32', 'C:\\Users\\Asha Rao'));
  assert.equal(d.kind, 'windows-startup');
  assert.ok(d.file.endsWith(win32.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'xo-agent.vbs')));
  assert.ok(
    d.content.includes(
      'sh.Run("""C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Asha Rao\\xo\\cli.js"" ""agent"" ""run"" ""--service""',
    ),
  );
  assert.ok(d.content.includes('""--log"" ""C:\\Users\\Asha Rao\\.xo'), 'Windows has no service log, so the agent writes its own');
  assert.ok(d.content.includes('"", 0, True) = 0 Then Exit Do'), 'hidden window, waited for; a clean stop ends it');
  assert.ok(d.content.includes('WScript.Sleep 30000\r\nLoop'), 'a crash restarts it after 30 seconds');
});

test('install writes the file and starts it; a failed start is reported; uninstall stops and removes it', async () => {
  await withTempDir('xo-agent-svc-', async (home) => {
    const calls: string[] = [];
    const ok: Runner = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { ok: !args.includes('bootout'), output: 'not loaded' });
    const r = await installService(ctx('darwin', home), { start: true }, ok);
    assert.equal(r.started, true, 'bootout of a job that was never loaded is not a failure');
    assert.equal(r.problem, undefined);
    assert.match(await readFile(r.definition.file, 'utf8'), /com\.xo\.agent/);
    assert.equal(((await stat(r.definition.file)).mode & 0o777).toString(8), '644');
    assert.deepEqual(calls, [`launchctl bootout gui/501/com.xo.agent`, `launchctl bootstrap gui/501 ${r.definition.file}`]);

    // Lingering may be forbidden; the service still installs and starts.
    const noLinger: Runner = async (cmd) => ({ ok: cmd !== 'loginctl', output: 'Access denied' });
    assert.equal((await installService(ctx('linux', home), { start: true }, noLinger)).started, true);
    const failing: Runner = async () => ({ ok: false, output: 'Failed to connect to bus' });
    const f = await installService(ctx('linux', home), { start: true }, failing);
    assert.equal(f.started, false);
    assert.match(f.problem ?? '', /systemctl --user daemon-reload failed: Failed to connect to bus/);
    const quiet = await installService(ctx('linux', home), { start: false }, failing);
    assert.equal(quiet.started, false);
    assert.equal(quiet.problem, undefined);

    calls.length = 0;
    const u = await uninstallService(
      ctx('darwin', home),
      async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { ok: true, output: '' }),
    );
    assert.deepEqual(calls, ['launchctl bootout gui/501/com.xo.agent']);
    await assert.rejects(stat(u.definition.file));
  });
});

test('changes the sync never sends do not wake the agent', () => {
  assert.equal(ignoredChange('.DS_Store'), true);
  assert.equal(ignoredChange('Certificates/~$draft.docx'), true);
  assert.equal(ignoredChange('Certificates\\.git\\index'), true);
  assert.equal(ignoredChange('Certificates/Asha Rao.pdf'), false);
  assert.equal(ignoredChange(null), false, 'a platform that does not name the file still counts as a change');
});
