import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** `/Users/me/dev/xo` -> `~/dev/xo`, and long paths get their middle elided (`~/…/deep/dir`) to fit `max` columns. */
export function shortenPath(path: string, max: number, home: string = homedir()): string {
  let p = path;
  if (home !== '' && (p === home || p.startsWith(home + sep))) p = `~${p.slice(home.length)}`;
  if (p.length <= max) return p;
  const parts = p.split(sep);
  if (parts.length <= 2) return `…${p.slice(-(max - 1))}`;
  const head = parts[0] === '' ? sep : `${parts[0]}${sep}`;
  let tail = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i > 0; i -= 1) {
    const candidate = `${parts[i]}${sep}${tail}`;
    if (head.length + 2 + candidate.length > max) break;
    tail = candidate;
  }
  const result = `${head}…${sep}${tail}`;
  return result.length <= max ? result : `…${result.slice(-(max - 1))}`;
}

/** Current git branch (or short detached hash) found by walking up from `cwd` to a `.git`; reads `HEAD` directly, never spawns git. */
export function readGitBranch(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      try {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!pointer) return undefined;
          gitDir = resolve(dir, pointer[1]!.trim());
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1]! : head.slice(0, 7);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface CopyResult {
  readonly ok: boolean;
  readonly method: string;
}

/** Candidate native clipboard tools per platform, tried in order. */
export function clipboardCommands(platform: NodeJS.Platform = process.platform): readonly (readonly string[])[] {
  if (platform === 'darwin') return [['pbcopy']];
  if (platform === 'win32') return [['clip']];
  return [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
}

function pipeTo(cmd: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const [bin, ...args] = cmd;
    if (!bin) return resolvePromise(false);
    let settled = false;
    const finish = (v: boolean): void => {
      if (!settled) {
        settled = true;
        resolvePromise(v);
      }
    };
    try {
      const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      child.stdin.on('error', () => finish(false));
      child.stdin.end(text);
    } catch {
      finish(false);
    }
  });
}

/** Copies via a native clipboard tool; falls back to an OSC 52 escape (works over SSH in terminals that allow it). */
export async function copyToClipboard(text: string, writeRaw: (s: string) => void, platform: NodeJS.Platform = process.platform): Promise<CopyResult> {
  for (const cmd of clipboardCommands(platform)) {
    if (await pipeTo(cmd, text)) return { ok: true, method: cmd[0]! };
  }
  writeRaw(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
  return { ok: true, method: 'terminal escape (OSC 52)' };
}
