/**
 * UW-12a part 2 — `xo agent`: keeps a folder on THIS computer connected to an XO instance that runs somewhere else.
 *
 *   xo agent pair --server <url> --code <XXXX-XXXX-XXXX-XXXX> --folder <path> [--label <name>] [--config <file>]
 *   xo agent run [--once] [--config <file>]       sync now, then soon after every change and on the instance's schedule
 *   xo agent install [--no-start] [--config <file>]   start it at sign-in and keep it running (no administrator rights)
 *   xo agent uninstall [--config <file>]
 *   xo agent status [--config <file>]
 *
 * It only reads the folder, and only calls out to the instance (https; plain http only to this computer). The configuration file
 * (default `~/.xo/agent.json`) holds the agent token: it is written owner-only (0600) and refused when others can read it.
 */
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AgentError, pairAgent, runAgentOnce, type AgentHttp, type DigestCache } from '@xo/connect';
import { resolveRoot } from '@xo/environment-intelligence';
import type { CommandRegistry } from '../../command-registry.js';
import { agentLoop } from './loop.js';
import { installService, uninstallService, type ServiceContext } from './service.js';

const SUBSYSTEM = 'agent';
const VERSION = '1';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const str = (f: Readonly<Record<string, string | boolean>>, k: string): string | undefined =>
  typeof f[k] === 'string' ? (f[k] as string) : undefined;

export interface AgentConfig {
  readonly schema: 'xo.agent-config/1';
  readonly server: string;
  readonly connectionId: string;
  readonly token: string;
  /** The real path of the folder, as approved when pairing. */
  readonly folder: string;
  readonly folderName: string;
  readonly cache: DigestCache;
  readonly lastRun?: { readonly at: string; readonly uploaded: number; readonly listed: number; readonly outcome?: string };
}

const defaultConfig = (): string => join(homedir(), '.xo', 'agent.json');

export async function readAgentConfig(path: string): Promise<AgentConfig> {
  const st = await stat(path);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
    throw new AgentError('unpaired', `${path} can be read by other users; run: chmod 600 ${path}`);
  const c = JSON.parse(await readFile(path, 'utf8')) as AgentConfig;
  if (c.schema !== 'xo.agent-config/1') throw new AgentError('unpaired', `${path} is not an agent configuration`);
  return c;
}

export async function writeAgentConfig(path: string, c: AgentConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

const http: AgentHttp = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });

/** Pairs this computer's folder with the connection the code was made for. */
export async function pairCommand(
  o: { server: string; code: string; folder: string; label?: string; config: string },
  h: AgentHttp = http,
): Promise<AgentConfig> {
  const real = await resolveRoot(resolve(o.folder));
  if (!real.ok) throw new AgentError('bad_folder', `the folder cannot be used: ${real.error.message}`);
  const folderName = basename(real.value);
  const paired = await pairAgent(h, o.server, {
    code: o.code,
    folderName,
    label: o.label ?? hostname(),
    platform: platform(),
    agentVersion: VERSION,
  });
  const c: AgentConfig = {
    schema: 'xo.agent-config/1',
    server: o.server,
    connectionId: paired.connectionId,
    token: paired.token,
    folder: real.value,
    folderName,
    cache: {},
  };
  await writeAgentConfig(o.config, c);
  return c;
}

/** One sync. Returns the updated configuration (its digest cache and last run). */
export async function runOnce(
  config: string,
  h: AgentHttp = http,
): Promise<{ config: AgentConfig; everyMinutes: number; requested: boolean }> {
  const c = await readAgentConfig(config);
  const real = await resolveRoot(c.folder);
  if (!real.ok || real.value !== c.folder)
    throw new AgentError('bad_folder', 'the paired folder was moved, removed or replaced by a link; pair again');
  const r = await runAgentOnce(h, c.server, c.token, c.folder, c.folderName, c.cache);
  const outcome = (r.report as { lastSync?: { outcome?: string } } | undefined)?.lastSync?.outcome;
  const next: AgentConfig = {
    ...c,
    cache: r.cache,
    lastRun: { at: new Date().toISOString(), uploaded: r.uploaded, listed: r.listed, ...(outcome !== undefined ? { outcome } : {}) },
  };
  await writeAgentConfig(config, next);
  return { config: next, everyMinutes: r.manifest.syncEveryMinutes, requested: r.manifest.syncRequested };
}

/** One agent per configuration: the pid file beside it names the running one. */
const pidFile = (config: string): string => join(dirname(config), 'agent.pid');
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
async function claimPid(config: string): Promise<number | undefined> {
  const f = pidFile(config);
  const held = Number.parseInt(await readFile(f, 'utf8').catch(() => ''), 10);
  if (Number.isInteger(held) && held !== process.pid && alive(held)) return held;
  await writeFile(f, String(process.pid), { mode: 0o600 });
  return undefined;
}

export async function serviceContext(config: string): Promise<ServiceContext> {
  const cli = await realpath(process.argv[1] ?? '').catch(() => resolve(process.argv[1] ?? 'xo'));
  return {
    platform: process.platform,
    home: homedir(),
    node: process.execPath,
    cli,
    config,
    ...(process.platform !== 'win32' ? { uid: userInfo().uid } : {}),
    ...(process.env['APPDATA'] !== undefined ? { appData: process.env['APPDATA'] } : {}),
  };
}

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'The local agent: a folder on this computer, connected to an XO instance elsewhere (read-only)');
  registry.register({
    name: 'agent',
    subsystem: SUBSYSTEM,
    usage:
      'xo agent pair --server <url> --code <pairing code> --folder <path> [--label <name>] [--config <file>]\n' +
      '                        Pairs this folder with the connection the code was made for (the code is shown once, in XO)\n' +
      "xo agent run [--once] [--config <file>]   Syncs now, then a few seconds after each change, on the instance's schedule, and\n" +
      '                        whenever someone asks in XO (Ctrl+C to stop); it waits and retries while XO cannot be reached\n' +
      'xo agent install [--no-start] [--config <file>]   Starts the agent at sign-in and keeps it running (no administrator rights)\n' +
      'xo agent uninstall [--config <file>]       Stops it starting at sign-in, and stops it\n' +
      'xo agent status [--config <file>]          The paired folder and the last sync\n' +
      '                        The configuration (default ~/.xo/agent.json) holds the agent token; it is kept owner-only (0600).',
    run: async (args) => {
      const [sub] = args.positionals;
      const config = resolve(str(args.flags, 'config') ?? defaultConfig());
      try {
        if (sub === 'pair') {
          const server = str(args.flags, 'server');
          const code = str(args.flags, 'code');
          const folder = str(args.flags, 'folder');
          if (server === undefined || code === undefined || folder === undefined)
            return fail('usage: xo agent pair --server <url> --code <pairing code> --folder <path>');
          const label = str(args.flags, 'label');
          const c = await pairCommand({ server, code, folder, config, ...(label !== undefined ? { label } : {}) });
          out(`paired "${c.folderName}" with ${c.server} (connection ${c.connectionId}); configuration in ${config}`);
          out('next: xo agent install   (starts it now, at every sign-in, and keeps it running)');
          return 0;
        }
        if (sub === 'status') {
          const c = await readAgentConfig(config);
          out(`folder: ${c.folder}\nserver: ${c.server}\nconnection: ${c.connectionId}`);
          out(
            c.lastRun !== undefined
              ? `last sync: ${c.lastRun.at} (${c.lastRun.listed} files, ${c.lastRun.uploaded} uploaded, ${c.lastRun.outcome ?? 'unknown'})`
              : 'not synced yet',
          );
          return 0;
        }
        if (sub === 'run') {
          const service = args.flags['service'] === true;
          const logFile = str(args.flags, 'log');
          const log = (line: string): void => {
            if (logFile !== undefined) appendFileSync(logFile, `${line}\n`);
            else out(line);
          };
          if (args.flags['once'] === true) {
            const r = await runOnce(config);
            log(`${new Date().toISOString()} synced ${r.config.lastRun?.listed ?? 0} files (${r.config.lastRun?.uploaded ?? 0} sent)`);
            return 0;
          }
          const other = await claimPid(config);
          if (other !== undefined) return fail(`an agent for this configuration is already running (process ${other})`);
          const stop = new AbortController();
          const quit = (): void => stop.abort();
          process.once('SIGINT', quit);
          process.once('SIGTERM', quit);
          try {
            await agentLoop(config, { http, log }, { signal: stop.signal });
            return 0;
          } catch (e) {
            // As a service, an ending the person chose (retired, paired elsewhere, folder gone) is a clean stop, so it is not restarted.
            if (service && e instanceof AgentError) {
              log(`${new Date().toISOString()} stopped: ${e.message}`);
              return 0;
            }
            throw e;
          } finally {
            await rm(pidFile(config), { force: true });
          }
        }
        if (sub === 'install') {
          await readAgentConfig(config); // paired first
          const r = await installService(await serviceContext(config), { start: args.flags['no-start'] !== true });
          out(`installed ${r.definition.kind === 'windows-startup' ? 'a sign-in script' : 'a service'}: ${r.definition.file}`);
          if (r.problem !== undefined) return fail(`it will start at the next sign-in, but could not be started now: ${r.problem}`);
          out(r.started ? `the agent is running; its log: ${r.definition.log}` : 'the agent starts at the next sign-in');
          return 0;
        }
        if (sub === 'uninstall') {
          const r = await uninstallService(await serviceContext(config));
          const pid = Number.parseInt(await readFile(pidFile(config), 'utf8').catch(() => ''), 10);
          if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) process.kill(pid);
          out(`removed ${r.definition.file}; the agent no longer starts at sign-in`);
          if (r.problem !== undefined) out(`note: ${r.problem}`);
          return 0;
        }
        return fail('usage: xo agent <pair|run|install|uninstall|status> ...');
      } catch (e) {
        if (e instanceof AgentError) return fail(e.message);
        throw e;
      }
    },
  });
}
