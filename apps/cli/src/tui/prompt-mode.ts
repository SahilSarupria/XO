import type { CommandResult } from '../command-result.js';
import { failWith } from '../command-result.js';
import { SettingsStore } from './settings.js';
import type { QueryRequest } from './repl.js';

export interface StdinLike {
  readonly isTTY?: boolean;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeListener(event: 'data' | 'end', listener: (...args: never[]) => void): unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  setEncoding?: (enc: BufferEncoding) => unknown;
}

/**
 * Reads piped stdin (`cat claim.txt | xo -p "assess this"`). Returns
 * undefined for a TTY. If nothing arrives within `idleMs` and the stream
 * has not ended, gives up rather than hanging on an inherited-but-idle
 * pipe (a script that never closes stdin); once data starts flowing it
 * waits for the end.
 */
export function readPipedStdin(stdin: StdinLike, idleMs = 1000): Promise<string | undefined> {
  if (stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let text = '';
    let started = false;
    const finish = (): void => {
      clearTimeout(timer);
      stdin.removeListener('data', onData as (...args: never[]) => void);
      stdin.removeListener('end', onEnd as (...args: never[]) => void);
      stdin.pause?.();
      resolve(text === '' ? undefined : text);
    };
    const onData = (chunk: Buffer | string): void => {
      started = true;
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    };
    const onEnd = (): void => finish();
    const timer = setTimeout(() => {
      if (!started) finish();
    }, idleMs);
    timer.unref();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume?.();
  });
}

export interface PromptModeOptions {
  readonly prompt: string;
  readonly stdinText?: string | undefined;
  readonly storeFlag?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly providerFlags?: QueryRequest['providerFlags'];
  readonly json: boolean;
  readonly home: string;
  readonly runQuery: (request: QueryRequest) => Promise<CommandResult>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `xo -p "<question>"` — the non-interactive form of a session query.
 * Text mode prints only the model's answer on stdout (the run receipt
 * goes to stderr), so `xo -p ... | tee answer.md` captures just the
 * answer; `--output-format json` prints `xo run --json`'s payload.
 * Exit code is the query's own.
 */
export async function runPromptMode(o: PromptModeOptions): Promise<number> {
  const settings = new SettingsStore(o.home).load().settings;
  const storeDir = o.storeFlag ?? settings.storeDir;
  if (!storeDir) {
    for (const line of failWith('-p needs a package store: pass --store <dir> (or set one with /store in an interactive session)').lines) o.stdout(`${line}\n`);
    return 1;
  }
  const provider = o.provider ?? settings.provider;
  const model = o.model ?? settings.model;
  let result: CommandResult;
  try {
    result = await o.runQuery({
      query: o.prompt,
      input: o.stdinText !== undefined ? `${o.prompt}\n\n${o.stdinText}` : o.prompt,
      storeDir,
      json: o.json,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(o.providerFlags !== undefined ? { providerFlags: o.providerFlags } : {}),
    });
  } catch (cause) {
    o.stderr(`error: query failed: ${(cause as Error).message}\n`);
    return 1;
  }

  if (result.exitCode !== 0 || o.json) {
    for (const line of result.lines) (result.exitCode !== 0 && !o.json ? o.stderr : o.stdout)(`${line}\n`);
    return result.exitCode;
  }
  const at = result.lines.indexOf('--- receipt ---');
  const answer = at === -1 ? result.lines : result.lines.slice(0, at);
  for (const line of answer.filter((l) => !l.startsWith('warning:'))) o.stdout(`${line}\n`);
  for (const line of at === -1 ? [] : result.lines.slice(at)) o.stderr(`${line}\n`);
  for (const line of answer.filter((l) => l.startsWith('warning:'))) o.stderr(`${line}\n`);
  return 0;
}
