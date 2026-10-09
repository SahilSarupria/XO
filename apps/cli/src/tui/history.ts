import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_ENTRIES = 500;

/** Strips secrets before a line is written to the history file: the value after `--api-key` (space or `=` form) is replaced with `***`. */
export function redactForHistory(line: string): string {
  return line.replace(/(--api-key(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/g, '$1***');
}

/**
 * Prompt history with up/down navigation. Entries persist one JSON string
 * per line (so multi-line prompts round-trip), capped at 500, consecutive
 * duplicates collapsed, `--api-key` values redacted on disk.
 */
export class History {
  private entries: string[] = [];
  private cursor: number | undefined;
  private draft = '';
  readonly path: string | undefined;

  constructor(home: string | undefined) {
    this.path = home === undefined ? undefined : join(home, 'history');
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const out: string[] = [];
      for (const raw of readFileSync(this.path, 'utf8').split('\n')) {
        if (raw === '') continue;
        try {
          const v: unknown = JSON.parse(raw);
          if (typeof v === 'string' && v !== '') out.push(v);
        } catch {
          // Skip a corrupt line rather than discard the whole history.
        }
      }
      this.entries = out.slice(-MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
  }

  get all(): readonly string[] {
    return this.entries;
  }

  add(line: string): void {
    this.cursor = undefined;
    this.draft = '';
    const trimmed = line.trim();
    if (trimmed === '' || this.entries[this.entries.length - 1] === line) return;
    this.entries.push(line);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, `${this.entries.map((e) => JSON.stringify(redactForHistory(e))).join('\n')}\n`, { mode: 0o600 });
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort.
      }
    } catch {
      // History is a convenience; never let it break the session.
    }
  }

  /** Starts (or continues) walking backwards; `current` is remembered as the draft on the first step. */
  previous(current: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor === undefined) {
      this.draft = current;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    } else {
      return undefined;
    }
    return this.entries[this.cursor];
  }

  next(): string | undefined {
    if (this.cursor === undefined) return undefined;
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      return this.entries[this.cursor];
    }
    this.cursor = undefined;
    return this.draft;
  }

  resetNavigation(): void {
    this.cursor = undefined;
    this.draft = '';
  }
}
