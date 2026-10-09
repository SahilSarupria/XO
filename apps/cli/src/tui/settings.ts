import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Persisted interactive-session preferences. Never holds credentials — API keys come from the environment only. */
export interface Settings {
  readonly theme?: string;
  readonly storeDir?: string;
  readonly registryDir?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly wittyPhrases?: boolean;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] | undefined };

export function xoHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env['XO_HOME'];
  return override !== undefined && override !== '' ? override : join(homedir(), '.xo');
}

export interface LoadedSettings {
  readonly settings: Settings;
  readonly warning?: string;
}

const STRING_KEYS = ['theme', 'storeDir', 'registryDir', 'provider', 'model'] as const;

export class SettingsStore {
  readonly path: string;

  constructor(readonly home: string) {
    this.path = join(home, 'settings.json');
  }

  load(): LoadedSettings {
    if (!existsSync(this.path)) return { settings: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (cause) {
      return { settings: {}, warning: `ignoring unreadable settings file ${this.path}: ${(cause as Error).message}` };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { settings: {}, warning: `ignoring ${this.path}: expected a JSON object` };
    const obj = raw as Record<string, unknown>;
    const settings: Record<string, string | boolean> = {};
    for (const key of STRING_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v !== '') settings[key] = v;
    }
    if (typeof obj['wittyPhrases'] === 'boolean') settings['wittyPhrases'] = obj['wittyPhrases'];
    return { settings: settings as Settings };
  }

  /** Merges `patch` into the file on disk (a key set to `undefined` is removed). Returns an error message instead of throwing — persistence is a convenience, never a reason to fail a command. */
  save(patch: SettingsPatch): string | undefined {
    try {
      const merged: Record<string, unknown> = { ...this.load().settings };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort on filesystems without POSIX modes.
      }
      return undefined;
    } catch (cause) {
      return `could not save settings to ${this.path}: ${(cause as Error).message}`;
    }
  }
}
