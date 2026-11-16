/**
 * UW-12a part 2 — `xo agent install`: start the agent when the person signs in, and keep it running, without administrator rights.
 *
 *   macOS    a LaunchAgent (~/Library/LaunchAgents/com.xo.agent.plist), loaded with `launchctl bootstrap gui/<uid>`; launchd
 *            starts it at login and restarts it if it crashes.
 *   Linux    a systemd user unit (~/.config/systemd/user/xo-agent.service, WantedBy=default.target), `systemctl --user enable
 *            --now`; systemd starts it at login and restarts it on failure.
 *   Windows  a script in the person's Startup folder (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup), which Windows runs
 *            at sign-in, hidden. Windows does not restart it after a crash; it starts again at the next sign-in.
 *
 * The service runs `xo agent run --service`: it stops cleanly (exit 0, so it is not restarted) when the connection is retired or
 * paired elsewhere, and keeps one agent per configuration through a pid file next to it.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, win32 } from 'node:path';

export const SERVICE_LABEL = 'com.xo.agent';
export const SYSTEMD_UNIT = 'xo-agent.service';

export interface ServiceContext {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Absolute path of the Node.js executable that runs the CLI. */
  readonly node: string;
  /** Absolute path of the CLI entry script. */
  readonly cli: string;
  /** Absolute path of the agent configuration. */
  readonly config: string;
  readonly uid?: number;
  /** %APPDATA% on Windows. */
  readonly appData?: string;
}

export interface ServiceDefinition {
  readonly kind: 'launchd' | 'systemd' | 'windows-startup';
  readonly file: string;
  readonly content: string;
  /** Run in order after writing the file; the first may fail harmlessly when nothing was installed before. */
  readonly start: readonly (readonly string[])[];
  readonly stop: readonly (readonly string[])[];
  readonly log: string;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** systemd: quoted arguments, with backslash, quote and % escaped (systemd.service(5), "Command lines"). */
const unitArg = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
/** VBScript string literal content: quotes doubled. */
const vbs = (s: string): string => s.replace(/"/g, '""');

export function serviceDefinition(ctx: ServiceContext): ServiceDefinition {
  // Paths follow the target platform's rules, whatever machine builds the definition.
  const { join, dirname } = ctx.platform === 'win32' ? win32 : posix;
  const args = [ctx.node, ctx.cli, 'agent', 'run', '--service', '--config', ctx.config];
  const log = join(dirname(ctx.config), 'agent.log');
  if (ctx.platform === 'darwin') {
    const file = join(ctx.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const domain = `gui/${ctx.uid ?? 501}`;
    return {
      kind: 'launchd',
      file,
      log,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`,
      start: [
        ['launchctl', 'bootout', `${domain}/${SERVICE_LABEL}`],
        ['launchctl', 'bootstrap', domain, file],
      ],
      stop: [['launchctl', 'bootout', `${domain}/${SERVICE_LABEL}`]],
    };
  }
  if (ctx.platform === 'win32') {
    const appData = ctx.appData ?? join(ctx.home, 'AppData', 'Roaming');
    const file = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'xo-agent.vbs');
    const command = [...args, '--log', log].map((a) => `""${vbs(a)}""`).join(' ');
    return {
      kind: 'windows-startup',
      file,
      log,
      content: `' XO agent: keeps a folder on this computer connected to XO. Remove with: xo agent uninstall\r\nCreateObject("WScript.Shell").Run "${command}", 0, False\r\n`,
      start: [['wscript.exe', file]],
      stop: [],
    };
  }
  const file = join(ctx.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
  return {
    kind: 'systemd',
    file,
    log: 'journalctl --user -u xo-agent',
    content: `[Unit]
Description=XO agent (keeps a folder on this computer connected to XO)
After=network-online.target

[Service]
Type=simple
ExecStart=${args.map(unitArg).join(' ')}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`,
    start: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
    ],
    stop: [['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]],
  };
}

export type Runner = (cmd: string, args: readonly string[]) => Promise<{ ok: boolean; output: string }>;

export const execRunner: Runner = (cmd, args) =>
  new Promise((done) => {
    execFile(cmd, [...args], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      done({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
    );
  });

/** Writes the definition and starts it. With `start: false` only the file is written (the agent starts at the next sign-in). */
export async function installService(
  ctx: ServiceContext,
  o: { start: boolean },
  run: Runner = execRunner,
): Promise<{ definition: ServiceDefinition; started: boolean; problem?: string }> {
  const d = serviceDefinition(ctx);
  await mkdir(dirname(d.file), { recursive: true });
  await writeFile(d.file, d.content, { mode: 0o644 });
  if (!o.start) return { definition: d, started: false };
  for (const [i, c] of d.start.entries()) {
    const r = await run(c[0]!, c.slice(1));
    // launchd: booting out a job that was never loaded fails, and that is fine.
    if (!r.ok && !(d.kind === 'launchd' && i === 0))
      return { definition: d, started: false, problem: `${c.join(' ')} failed${r.output !== '' ? `: ${r.output}` : ''}` };
  }
  return { definition: d, started: true };
}

export async function uninstallService(
  ctx: ServiceContext,
  run: Runner = execRunner,
): Promise<{ definition: ServiceDefinition; problem?: string }> {
  const d = serviceDefinition(ctx);
  let problem: string | undefined;
  for (const c of d.stop) {
    const r = await run(c[0]!, c.slice(1));
    if (!r.ok) problem = `${c.join(' ')}: ${r.output}`;
  }
  await rm(d.file, { force: true });
  if (d.kind === 'systemd') await run('systemctl', ['--user', 'daemon-reload']);
  return { definition: d, ...(problem !== undefined ? { problem } : {}) };
}
