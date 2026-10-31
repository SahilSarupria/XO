import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import type { FreightTask } from '../scenario/freight/generate.js';
import type { Arm, ArmId, ArmRun } from './arms.js';
import { scoreTask, type TaskScore } from './scoring.js';

export interface EvalRecord {
  readonly arm: ArmId;
  readonly taskId: string;
  readonly stratum: string;
  readonly trial: number;
  readonly score: TaskScore;
  readonly run: ArmRun;
}

export interface RunOptions {
  readonly arms: readonly Arm[];
  readonly tasks: readonly FreightTask[];
  readonly trials?: number;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, rec: EvalRecord) => void;
  /** Abort the whole run after this many consecutive transport failures (default 8; 0 disables). A dead endpoint must not be scored as wrong answers. */
  readonly abortAfterConsecutiveTransportErrors?: number;
  /** Previously completed records; any non-transport-failure record for the same (arm, task, trial) is reused instead of re-run (no repeat spend). */
  readonly resume?: readonly EvalRecord[];
}

/** A run record whose model call never produced a reply (HTTP/auth/model-not-found/network), as opposed to a reply that was merely wrong. */
export function isTransportError(rec: Pick<EvalRecord, 'run'>): boolean {
  const e = rec.run.error;
  return (
    e !== undefined &&
    e !== 'no JSON object in reply' &&
    rec.run.path === 'model' &&
    rec.run.inputTokens === 0 &&
    rec.run.outputTokens === 0
  );
}

export class EvalAbortedError extends Error {
  constructor(
    readonly sample: string,
    readonly consecutive: number,
  ) {
    super(`aborted after ${consecutive} consecutive transport failures; first error: ${sample}`);
    this.name = 'EvalAbortedError';
  }
}

/** Seconds the API asked us to wait ("retry in 12.3s" / `"retryDelay": "12s"`), if it said. */
export function retryAfterSeconds(message: string): number | undefined {
  const m = /retry in ([\d.]+)\s*s|"retryDelay":\s*"([\d.]+)s"/i.exec(message);
  const v = m !== null ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

/** A quota that will not reset within this run (per-day / billing) — retrying only burns time. */
export function isExhaustedQuota(message: string): boolean {
  // Every Gemini 429 mentions "billing details", so only the metric name / a zero limit identifies a quota that will not reset in-run.
  return /PerDay|per day|limit: 0\b/i.test(message);
}

/**
 * Retries rate-limit/overload/network errors, honouring the server's retry delay (capped), with exponential backoff otherwise.
 * An exhausted daily/billing quota fails immediately with an actionable message instead of retrying. Anything else is surfaced as-is.
 */
export class RetryingProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly opts: {
      readonly attempts?: number;
      readonly baseDelayMs?: number;
      readonly maxDelayMs?: number;
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}
  get id() {
    return this.inner.id;
  }
  describeCapabilities() {
    return this.inner.describeCapabilities();
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const attempts = this.opts.attempts ?? 8;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.inner.complete(req);
      } catch (e) {
        lastErr = e;
        const m = (e as Error).message;
        if (isExhaustedQuota(m)) throw new Error(`QUOTA EXHAUSTED (not retrying): ${m.slice(0, 500)}`);
        if (!/\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|fetch failed/i.test(m) || i === attempts - 1)
          throw e;
        const hinted = retryAfterSeconds(m);
        const backoff = (this.opts.baseDelayMs ?? 2000) * 2 ** i + Math.floor(Math.random() * 250);
        await sleep(Math.min(this.opts.maxDelayMs ?? 90_000, hinted !== undefined ? hinted * 1000 + 500 : backoff));
      }
    }
    throw lastErr;
  }
}

/** Spaces model calls at least 60000/rpm ms apart across all concurrent workers (free tiers are per-minute limited). */
export class PacedProvider implements ModelProvider {
  private nextSlot = 0;
  constructor(
    private readonly inner: ModelProvider,
    private readonly rpm: number,
  ) {}
  get id() {
    return this.inner.id;
  }
  describeCapabilities() {
    return this.inner.describeCapabilities();
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const gap = 60_000 / this.rpm;
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + gap;
    if (at > now) await new Promise<void>((r) => setTimeout(r, at - now));
    return this.inner.complete(req);
  }
}

export async function runEval(o: RunOptions): Promise<EvalRecord[]> {
  const trials = o.trials ?? 1;
  const jobs: { arm: Arm; task: FreightTask; trial: number }[] = [];
  for (const arm of o.arms) for (const task of o.tasks) for (let trial = 1; trial <= trials; trial++) jobs.push({ arm, task, trial });
  const records: EvalRecord[] = new Array(jobs.length);
  const prior = new Map<string, EvalRecord>();
  for (const r of o.resume ?? []) if (!isTransportError(r)) prior.set(`${r.arm}|${r.taskId}|${r.trial}`, r);
  let next = 0;
  let done = 0;
  let streak = 0;
  let firstErr = '';
  let aborted: EvalAbortedError | undefined;
  const limit = o.abortAfterConsecutiveTransportErrors ?? 8;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted !== undefined) return;
      const i = next++;
      if (i >= jobs.length) return;
      const { arm, task, trial } = jobs[i] as (typeof jobs)[number];
      const reused = prior.get(`${arm.id}|${task.id}|${trial}`);
      if (reused !== undefined) {
        records[i] = reused;
        o.onProgress?.(++done, jobs.length, reused);
        continue;
      }
      const run = await arm.run(task);
      const rec: EvalRecord = { arm: arm.id, taskId: task.id, stratum: task.stratum, trial, score: scoreTask(task, run.output), run };
      records[i] = rec;
      if (isTransportError(rec)) {
        if (streak === 0) firstErr = (rec.run.error ?? '').slice(0, 400);
        streak++;
        if (limit > 0 && streak >= limit && aborted === undefined) aborted = new EvalAbortedError(firstErr, streak);
      } else if (rec.run.path === 'model') streak = 0;
      o.onProgress?.(++done, jobs.length, rec);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  if (aborted !== undefined) throw aborted;
  return records;
}
