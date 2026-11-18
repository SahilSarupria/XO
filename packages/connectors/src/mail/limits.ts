import { ConnectorError } from '../types.js';

/** UW-10: pacing and a per-day cap for one connection. In memory per connector instance; the cap's day is UTC. */
export interface SendLimits {
  /** Minimum milliseconds between sends (tier 2: 1000, tier 3: 5000). */
  readonly pacingMs: number;
  /** Sends per UTC day (default 400). */
  readonly dailyCap: number;
}

export interface LimitDeps {
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new ConnectorError('TIMEOUT', 'cancelled while pacing', 'none'))));
  });

export class SendGovernor {
  private last = 0;
  private day = '';
  private count = 0;
  private providerLimited = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly limits: SendLimits,
    private readonly deps: LimitDeps = {},
  ) {}
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  /** Waits for the pacing slot and counts the send. Refuses (effect none) once the cap or a provider limit is reached. */
  async take(signal: AbortSignal): Promise<void> {
    const run = this.queue.then(async () => {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      if (today !== this.day) {
        this.day = today;
        this.count = 0;
        this.providerLimited = false;
      }
      if (this.providerLimited) throw new ConnectorError('DENIED', 'the provider daily limit was reached; this send was not made', 'none');
      if (this.count >= this.limits.dailyCap)
        throw new ConnectorError('DENIED', 'the daily send cap was reached; this send was not made', 'none');
      const wait = this.last + this.limits.pacingMs - this.now();
      if (wait > 0) await (this.deps.sleep ?? realSleep)(wait, signal);
      this.last = this.now();
      this.count++;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  /** A provider said "daily limit": every later send today is refused without being tried. Never retried automatically. */
  markProviderLimited(): void {
    this.providerLimited = true;
  }
}

export interface EmailLimits {
  readonly maxAttachmentBytes: number;
  readonly limits: SendLimits;
}

/** The email limits for a tier from the instance settings (`XO_EMAIL_*`, see docs/CONFIGURATION.md). Tier 1 is not paced by XO (the provider is). */
export function emailLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  tier: 'native_api' | 'smtp_imap' | 'send_only',
): EmailLimits {
  const int = (name: string, fallback: number): number => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n >= 0 && env[name] !== undefined && env[name] !== '' ? n : fallback;
  };
  const pacingMs =
    tier === 'send_only' ? int('XO_EMAIL_PACING_SEND_ONLY_MS', 5000) : tier === 'smtp_imap' ? int('XO_EMAIL_PACING_SMTP_IMAP_MS', 1000) : 0;
  return {
    maxAttachmentBytes: int('XO_EMAIL_MAX_ATTACHMENT_MB', 20) * 1024 * 1024,
    limits: { pacingMs, dailyCap: int('XO_EMAIL_DAILY_CAP', 400) },
  };
}
