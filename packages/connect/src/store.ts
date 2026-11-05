import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_STATE, type ConnectState, type ConnectStateStore, type SourceConfig } from './ports.js';

export class ConnectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectStateError';
  }
}

/** Process-local store. Tests and single-process hosts only: nothing survives a restart. */
export class InMemoryConnectStateStore implements ConnectStateStore {
  private state: ConnectState = EMPTY_STATE;
  async load(): Promise<ConnectState> {
    return this.state;
  }
  async save(state: ConnectState): Promise<void> {
    this.state = state;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validConfig(c: unknown): c is SourceConfig {
  if (c === null || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o['ownerId'] === 'string' &&
    typeof o['sourceId'] === 'string' &&
    typeof o['root'] === 'string' &&
    isStringArray(o['includeKeys']) &&
    isStringArray(o['excludedNames']) &&
    typeof o['disconnected'] === 'boolean' &&
    typeof o['createdAt'] === 'string' &&
    Array.isArray(o['history'])
  );
}

/**
 * Durable store: one JSON file, replaced atomically (write a temp file, then rename). A corrupt or unrecognised file is an error,
 * never silently treated as empty: starting empty would hide existing connections and could let a stopped source look new.
 */
export class FileConnectStateStore implements ConnectStateStore {
  private readonly file: string;
  constructor(private readonly dir: string) {
    this.file = join(dir, 'connect-state.json');
  }

  async load(): Promise<ConnectState> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE;
      throw new ConnectStateError('the Connect state file could not be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConnectStateError('the Connect state file is not valid');
    }
    const p = parsed as { version?: unknown; sources?: unknown } | null;
    if (p === null || typeof p !== 'object' || p.version !== 1 || p.sources === null || typeof p.sources !== 'object')
      throw new ConnectStateError('the Connect state file has an unrecognised format');
    const sources: Record<string, SourceConfig> = {};
    for (const [k, v] of Object.entries(p.sources as Record<string, unknown>)) {
      if (!validConfig(v) || k !== `${v.ownerId}/${v.sourceId}`) throw new ConnectStateError('the Connect state file has an invalid entry');
      sources[k] = v;
    }
    return { version: 1, sources };
  }

  async save(state: ConnectState): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch {
      throw new ConnectStateError('the Connect state could not be saved');
    }
  }
}
