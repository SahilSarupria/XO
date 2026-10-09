export interface CommandStat {
  count: number;
  failed: number;
  ms: number;
}

/** Environment variable each provider's API key is read from — mirrors `commands/runtime/provider-factory.ts`, which owns the real resolution. Used only to tell the user whether a key is *present*, never to read or show it. */
export const PROVIDER_KEY_ENV: Readonly<Record<string, string | undefined>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: undefined,
};

/** Mutable state for one interactive session. Persisted preferences live in settings.json; this holds them plus per-run bookkeeping. */
export class SessionState {
  storeDir: string | undefined;
  registryDir: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  witty = true;
  lastOutput = '';
  readonly startedAt: number;
  readonly stats = new Map<string, CommandStat>();

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  record(name: string, ok: boolean, ms: number): void {
    const stat = this.stats.get(name) ?? { count: 0, failed: 0, ms: 0 };
    stat.count += 1;
    if (!ok) stat.failed += 1;
    stat.ms += ms;
    this.stats.set(name, stat);
  }

  get totals(): { count: number; failed: number; ms: number } {
    let count = 0;
    let failed = 0;
    let ms = 0;
    for (const s of this.stats.values()) {
      count += s.count;
      failed += s.failed;
      ms += s.ms;
    }
    return { count, failed, ms };
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
