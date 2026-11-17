/**
 * UW-12a part 2 — the agent's running loop: sync soon after something in the folder changes, and on the instance's schedule anyway.
 *
 *   - A change in the folder (seen by a recursive file-system watch) syncs once the folder has been quiet for a few seconds, at
 *     most every `minGapMs`. Hidden files and Office lock files are ignored here, as they are by the sync.
 *   - The instance's interval (`syncEveryMinutes`) still applies, as the fallback for anything the watch misses (network drives,
 *     a watch the platform refuses, changes made while the computer slept).
 *   - "Sync now" in XO is picked up at the next check (every `checkMs`).
 *   - When XO cannot be reached, or refuses for a while, the agent waits longer each time (up to `maxBackoffMs`) and tries again;
 *     it never gives up on its own. It stops only when the connection was retired, the pairing was replaced, or the folder is gone.
 */
import { watch as fsWatch } from 'node:fs';
import { AgentError, agentManifest, type AgentHttp } from '@xo/connect';
import { readAgentConfig, runOnce } from './index.js';

export interface LoopOptions {
  readonly signal?: AbortSignal;
  readonly checkMs?: number;
  readonly debounceMs?: number;
  readonly minGapMs?: number;
  readonly firstBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export type Watcher = { close(): void };
export type WatchFolder = (
  folder: string,
  onChange: (relative: string | null) => void,
  onStop: (why: string) => void,
) => Watcher | undefined;

export interface LoopDeps {
  readonly http: AgentHttp;
  readonly watch?: WatchFolder;
  readonly log: (line: string) => void;
}

/** True for a path the sync never sends anyway: a hidden segment, or an Office lock file. */
export function ignoredChange(relative: string | null): boolean {
  if (relative === null) return false;
  return relative.split(/[\\/]/).some((seg) => seg.startsWith('.') || seg.startsWith('~$'));
}

/** The platform's recursive watch (macOS and Windows natively; Linux since Node 19.1). Undefined when it is not available here. */
export const nodeWatch: WatchFolder = (folder, onChange, onStop) => {
  try {
    const w = fsWatch(folder, { recursive: true, persistent: true }, (_event, name) => onChange(name === null ? null : String(name)));
    w.on('error', (e) => {
      w.close();
      onStop(e instanceof Error ? e.message : String(e));
    });
    return w;
  } catch {
    return undefined;
  }
};

function sleep(ms: number, signal: AbortSignal | undefined, wake: { fire: (() => void) | undefined }): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      wake.fire = undefined;
      done();
    };
    const t = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener('abort', finish, { once: true });
    wake.fire = finish;
  });
}

export async function agentLoop(config: string, deps: LoopDeps, o: LoopOptions = {}): Promise<void> {
  const checkMs = o.checkMs ?? 60_000;
  const debounceMs = o.debounceMs ?? 5_000;
  const minGapMs = o.minGapMs ?? 15_000;
  const firstBackoffMs = o.firstBackoffMs ?? 30_000;
  const maxBackoffMs = o.maxBackoffMs ?? 15 * 60_000;
  const c = await readAgentConfig(config);
  const wake: { fire: (() => void) | undefined } = { fire: undefined };
  let changedAt: number | undefined;
  let nextDue = 0;
  let lastSyncAt = -Infinity;
  let lastCheck = Date.now();
  let backoff = 0;
  let retryAt = 0;

  const watcher = (deps.watch ?? nodeWatch)(
    c.folder,
    (rel) => {
      if (ignoredChange(rel)) return;
      changedAt = Date.now();
      wake.fire?.();
    },
    (why) => deps.log(`watching the folder stopped (${why}); syncing on the schedule only`),
  );
  deps.log(
    watcher !== undefined
      ? `watching ${c.folderName}: changes are sent a few seconds after they happen`
      : `this computer cannot watch ${c.folderName}; syncing on the schedule only`,
  );

  try {
    while (o.signal?.aborted !== true) {
      const t = Date.now();
      let reason: string | undefined;
      if (t >= retryAt) {
        if (t >= nextDue) reason = backoff > 0 ? 'retry' : nextDue === 0 ? 'start' : 'schedule';
        else if (changedAt !== undefined && t - changedAt >= debounceMs && t - lastSyncAt >= minGapMs) reason = 'change';
        else if (t - lastCheck >= checkMs) {
          lastCheck = t;
          try {
            const fresh = await readAgentConfig(config);
            if ((await agentManifest(deps.http, fresh.server, fresh.token)).syncRequested) reason = 'asked in XO';
          } catch (e) {
            if (e instanceof AgentError && (e.code === 'retired' || e.code === 'unpaired')) throw e;
            // Unreachable for a moment: the next scheduled sync (with its back-off) deals with it.
          }
        }
      }
      if (reason !== undefined) {
        const started = Date.now();
        try {
          const r = await runOnce(config, deps.http);
          lastSyncAt = Date.now();
          if (changedAt !== undefined && changedAt <= started) changedAt = undefined;
          nextDue = lastSyncAt + r.everyMinutes * 60_000;
          backoff = 0;
          retryAt = 0;
          lastCheck = lastSyncAt;
          deps.log(
            `${new Date(lastSyncAt).toISOString()} synced (${reason}): ${r.config.lastRun?.listed ?? 0} files, ${r.config.lastRun?.uploaded ?? 0} sent`,
          );
        } catch (e) {
          if (!(e instanceof AgentError) || (e.code !== 'unreachable' && e.code !== 'refused')) throw e;
          backoff = backoff === 0 ? firstBackoffMs : Math.min(backoff * 2, maxBackoffMs);
          retryAt = Date.now() + backoff;
          nextDue = retryAt;
          deps.log(`${new Date().toISOString()} could not sync (${e.message}); trying again in ${Math.round(backoff / 1000)} s`);
        }
        continue;
      }
      const now = Date.now();
      const waits = [nextDue - now, lastCheck + checkMs - now, retryAt - now];
      if (changedAt !== undefined) waits.push(Math.max(changedAt + debounceMs, lastSyncAt + minGapMs) - now);
      await sleep(Math.max(50, Math.min(...waits.filter((w) => w > 0), checkMs)), o.signal, wake);
    }
  } finally {
    watcher?.close();
  }
}
