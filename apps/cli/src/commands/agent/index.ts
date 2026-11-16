/**
 * UW-12a part 2 — `xo agent`: keeps a folder on THIS computer connected to an XO instance that runs somewhere else.
 *
 *   xo agent pair --server <url> --code <XXXX-XXXX-XXXX-XXXX> --folder <path> [--label <name>] [--config <file>]
 *   xo agent run [--once] [--config <file>]
 *   xo agent status [--config <file>]
 *
 * It only reads the folder, and only calls out to the instance (https; plain http only to this computer). The configuration file
 * (default `~/.xo/agent.json`) holds the agent token: it is written owner-only (0600) and refused when others can read it.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AgentError, pairAgent, runAgentOnce, type AgentHttp, type DigestCache } from '@xo/connect';
import { resolveRoot } from '@xo/environment-intelligence';
import type { CommandRegistry } from '../../command-registry.js';

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

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'The local agent: a folder on this computer, connected to an XO instance elsewhere (read-only)');
  registry.register({
    name: 'agent',
    subsystem: SUBSYSTEM,
    usage:
      'xo agent pair --server <url> --code <pairing code> --folder <path> [--label <name>] [--config <file>]\n' +
      '                        Pairs this folder with the connection the code was made for (the code is shown once, in XO)\n' +
      'xo agent run [--once] [--config <file>]   Syncs now, then keeps syncing as the instance asks (Ctrl+C to stop)\n' +
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
          out('next: xo agent run');
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
          const once = args.flags['once'] === true;
          for (;;) {
            const r = await runOnce(config);
            out(`${new Date().toISOString()} synced ${r.config.lastRun?.listed ?? 0} files (${r.config.lastRun?.uploaded ?? 0} uploaded)`);
            if (once) return 0;
            // Check in every minute (a person may ask for a sync now); sync on the instance's interval.
            const due = Date.now() + r.everyMinutes * 60_000;
            while (Date.now() < due) {
              await new Promise((ok) => setTimeout(ok, 60_000));
              const m = await fetch(`${new URL(r.config.server).origin}/agent/v1/manifest`, {
                headers: { authorization: `Bearer ${r.config.token}` },
              }).catch(() => undefined);
              if (m?.status === 410) throw new AgentError('retired', 'this connection was retired on the instance');
              if (m?.ok === true && ((await m.json()) as { syncRequested?: boolean }).syncRequested === true) break;
            }
          }
        }
        return fail('usage: xo agent <pair|run|status> ...');
      } catch (e) {
        if (e instanceof AgentError) return fail(e.message);
        throw e;
      }
    },
  });
}
