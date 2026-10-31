import type { Emit, Trigger } from './triggers.js';

/** Five-field cron (`min hour day-of-month month day-of-week`, UTC): `*`, lists `1,5`, ranges `1-5`, steps (`*` or a range, then `/n`, e.g. every 15 minutes or 1-10 by 3); names are not supported. */
export interface CronSpec {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domStar: boolean;
  readonly dowStar: boolean;
}

const RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function field(src: string, [lo, hi]: readonly [number, number], name: string, dowSeven = false): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (m === null) throw new Error(`cron ${name}: cannot parse "${part}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`cron ${name}: step must be >= 1`);
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1]!.split('-').map(Number) as [number, number | undefined];
      a = x;
      b = y ?? (m[2] === undefined ? x : hi);
    }
    const max = dowSeven ? 7 : hi;
    if (a < lo || b > max || a > b) throw new Error(`cron ${name}: ${part} is outside ${lo}-${max}`);
    for (let v = a; v <= b; v += step) out.add(dowSeven && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  return {
    minute: field(f[0]!, RANGES[0]!, 'minute'),
    hour: field(f[1]!, RANGES[1]!, 'hour'),
    dom: field(f[2]!, RANGES[2]!, 'day-of-month'),
    month: field(f[3]!, RANGES[3]!, 'month'),
    dow: field(f[4]!, RANGES[4]!, 'day-of-week', true),
    domStar: f[2] === '*',
    dowStar: f[4] === '*',
  };
}

/** Standard cron rule: when both day-of-month and day-of-week are restricted, either matching is enough. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getUTCMinutes()) || !spec.hour.has(d.getUTCHours()) || !spec.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  return spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
}

/** First minute strictly after `from` that matches, searching up to ~5 years; undefined if none (e.g. Feb 31). */
export function nextCronTime(spec: CronSpec, from: Date): Date | undefined {
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 5 * 366 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) if (cronMatches(spec, t)) return new Date(t);
  return undefined;
}

/**
 * Fires on a cron schedule (UTC). The idempotency key is the scheduled minute, so a restart or a second instance inside the same
 * minute cannot run the job twice. A tick that was missed because the process was down is NOT replayed (documented: no catch-up).
 */
export class CronTrigger implements Trigger {
  private timer: NodeJS.Timeout | undefined;
  private readonly spec: CronSpec;
  constructor(
    readonly id: string,
    expr: string,
    private readonly opts: { readonly payload?: () => unknown; readonly now?: () => number } = {},
  ) {
    this.spec = parseCron(expr);
  }
  async start(emit: Emit): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const arm = (): void => {
      const next = nextCronTime(this.spec, new Date(now()));
      if (next === undefined) return;
      this.timer = setTimeout(
        () => {
          void emit({
            trigger: this.id,
            source: 'schedule',
            idempotencyKey: `${this.id}@${next.toISOString()}`,
            receivedAt: new Date(now()).toISOString(),
            payload: this.opts.payload?.() ?? { scheduledFor: next.toISOString() },
          });
          arm();
        },
        Math.max(0, next.getTime() - now()),
      );
      this.timer.unref();
    };
    arm();
  }
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
