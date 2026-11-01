import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Resolves a secret reference name (e.g. SMTP_PASSWORD) to its value. Values never appear in documents, ledgers, logs or errors. */
export interface SecretVault {
  get(name: string): string | undefined;
}

export class EnvVault implements SecretVault {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly prefix = 'XO_SECRET_',
  ) {}
  get(name: string): string | undefined {
    return this.env[`${this.prefix}${name}`];
  }
}

/** One file per secret under `dir` (e.g. a mounted secrets volume). Names are validated; no path traversal. */
export class FileVault implements SecretVault {
  constructor(private readonly dir: string) {}
  get(name: string): string | undefined {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return undefined;
    try {
      return readFileSync(join(resolve(this.dir), name), 'utf8').replace(/\r?\n$/, '');
    } catch {
      return undefined;
    }
  }
}

export class MapVault implements SecretVault {
  constructor(private readonly values: Readonly<Record<string, string>>) {}
  get(name: string): string | undefined {
    return this.values[name];
  }
}

/** Replaces every known secret value in `text` with `[REDACTED:NAME]`. Applied to every log line, ledger entry and error the host produces. */
export class Redactor {
  private readonly entries: { name: string; value: string }[] = [];
  track(name: string, value: string): void {
    if (value.length >= 4 && !this.entries.some((e) => e.value === value)) this.entries.push({ name, value });
    this.entries.sort((a, b) => b.value.length - a.value.length);
  }
  redact(text: string): string {
    let out = text;
    for (const e of this.entries) out = out.split(e.value).join(`[REDACTED:${e.name}]`);
    return out;
  }
  redactJson<T>(v: T): T {
    return JSON.parse(this.redact(JSON.stringify(v))) as T;
  }
}
