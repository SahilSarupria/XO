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
}

/** Retries rate-limit/overload/network errors with exponential backoff. Anything else is surfaced as-is (a bad request will not get better). */
export class RetryingProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly opts: {
      readonly attempts?: number;
      readonly baseDelayMs?: number;
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
    const attempts = this.opts.attempts ?? 5;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.inner.complete(req);
      } catch (e) {
        lastErr = e;
        const m = (e as Error).message;
        if (!/\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|fetch failed/i.test(m) || i === attempts - 1)
          throw e;
        await sleep((this.opts.baseDelayMs ?? 1000) * 2 ** i + Math.floor(Math.random() * 250));
      }
    }
    throw lastErr;
  }
}

export async function runEval(o: RunOptions): Promise<EvalRecord[]> {
  const trials = o.trials ?? 1;
  const jobs: { arm: Arm; task: FreightTask; trial: number }[] = [];
  for (const arm of o.arms) for (const task of o.tasks) for (let trial = 1; trial <= trials; trial++) jobs.push({ arm, task, trial });
  const records: EvalRecord[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { arm, task, trial } = jobs[i] as (typeof jobs)[number];
      const run = await arm.run(task);
      const rec: EvalRecord = { arm: arm.id, taskId: task.id, stratum: task.stratum, trial, score: scoreTask(task, run.output), run };
      records[i] = rec;
      o.onProgress?.(++done, jobs.length, rec);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return records;
}
