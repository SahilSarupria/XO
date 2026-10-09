import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripAnsi } from '../src/tui/ansi.js';

export async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-tui-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lets queued stream events and microtasks run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

export interface FakeTerminal {
  readonly stdin: PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => unknown; rawMode: boolean };
  readonly stdout: { isTTY: boolean; columns: number; write(chunk: string): boolean; on(): void; removeListener(): void; getColorDepth(): number };
  /** Everything written to stdout so far, escape codes included. */
  raw(): string;
  /** Same, with escape codes removed. */
  plain(): string;
  send(bytes: string): Promise<void>;
}

/** A TTY-shaped stdin/stdout pair: feed keystrokes with `send`, inspect what the UI wrote. */
export function fakeTerminal(columns = 80): FakeTerminal {
  const stdin = new PassThrough() as FakeTerminal['stdin'];
  stdin.isTTY = true;
  stdin.rawMode = false;
  stdin.setRawMode = (m: boolean) => {
    stdin.rawMode = m;
    return stdin;
  };
  const chunks: string[] = [];
  const stdout = {
    isTTY: true,
    columns,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    on(): void {},
    removeListener(): void {},
    getColorDepth: () => 24,
  };
  return {
    stdin,
    stdout,
    raw: () => chunks.join(''),
    plain: () => stripAnsi(chunks.join('')),
    send: async (bytes: string) => {
      stdin.write(bytes);
      await settle();
    },
  };
}

export const KEY = {
  enter: '\r',
  ctrlJ: '\n',
  tab: '\t',
  backspace: '\x7f',
  ctrlA: '\x01',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlE: '\x05',
  ctrlK: '\x0b',
  ctrlU: '\x15',
  ctrlW: '\x17',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pasteStart: '\x1b[200~',
  pasteEnd: '\x1b[201~',
} as const;
