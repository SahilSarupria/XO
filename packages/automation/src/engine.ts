import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@xo/capability-layer';
import { HashChainLedger } from './ledger.js';
import type { EmitResult, Trigger, TriggerEvent } from './triggers.js';

export type Disposition = 'completed' | 'needs_human' | 'rejected';

export interface WorkflowOutcome {
  readonly disposition: Disposition;
  readonly summary: string;
  readonly output?: unknown;
  /** Where to file the result for people/other systems: `outbox/<lane>/<runId>.json`. */
  readonly lane: string;
}

export interface RunContext {
  readonly runId: string;
  readonly attempt: number;
  readonly workflowId: string;
}

/** Throw this from a handler for a failure that will not get better on retry (bad input, rule violation). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly triggers: readonly Trigger[];
  readonly run: (event: TriggerEvent, ctx: RunContext) => Promise<WorkflowOutcome>;
  readonly maxAttempts?: number;
  /** Accepting more than this many events per minute returns `rate_limited` (webhooks answer 429). */
  readonly maxRunsPerMinute?: number;
}

export interface EngineOptions {
  /** Root for ledger, pending state and outbox. */
  readonly dir: string;
  readonly workflows: readonly WorkflowDefinition[];
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly backoffBaseMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Job {
  readonly runId: string;
  readonly wf: WorkflowDefinition;
  readonly event: TriggerEvent;
  readonly key: string;
}

const h = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 16);

/**
 * Runs XO workflows unattended. Guarantees:
 *  - **at-most-once per idempotency key** (including across restarts — keys are rebuilt from the ledger);
 *  - **no lost work**: an accepted event is persisted before it is acknowledged, and unfinished work is re-queued on startup;
 *  - **bounded**: queue length, concurrency, per-workflow rate limits and retry counts are all capped;
 *  - **auditable**: every state change is appended to a hash-chained ledger;
 *  - **humans stay in the loop**: `needs_human` outcomes land in an outbox lane for a person or another system.
 */
export class AutomationEngine {
  private ledger!: HashChainLedger;
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];
  private active = 0;
  /** events being persisted/acknowledged right now — not yet queued, but definitely coming */
  private accepting = 0;
  private stopped = true;
  private readonly recent = new Map<string, number[]>();
  private idleWaiters: (() => void)[] = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  readonly counters = { accepted: 0, completed: 0, failed: 0, duplicates: 0, retries: 0, rejected: 0 };

  constructor(private readonly opts: EngineOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
  }

  get ledgerHead(): string {
    return this.ledger.head;
  }
  get ledgerEntries(): ReturnType<HashChainLedger['entries']> {
    return this.ledger.entries();
  }
  get ledgerPath(): string {
    return join(this.opts.dir, 'ledger.jsonl');
  }

  async start(): Promise<void> {
    await Promise.all(['state/pending', 'outbox'].map((d) => mkdir(join(this.opts.dir, d), { recursive: true })));
    this.ledger = await HashChainLedger.open(this.ledgerPath, this.now);
    for (const e of this.ledger.entries()) if (e.type === 'job.accepted') this.seen.add((e.data as { key: string }).key);
    this.stopped = false;
    await this.ledger.append('engine.started', { workflows: this.opts.workflows.map((w) => w.id) });
    await this.recover();
    for (const wf of this.opts.workflows) for (const t of wf.triggers) await t.start((ev) => this.acceptTracked(wf, ev));
  }

  /** Re-queues work that was accepted but never settled (crash, kill -9, power loss). At-least-once execution of at-most-once-keyed work: handlers must be idempotent in their side effects. */
  private async recover(): Promise<void> {
    const dir = join(this.opts.dir, 'state/pending');
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const rec = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
          runId: string;
          workflowId: string;
          key: string;
          event: Omit<TriggerEvent, 'onSettled'>;
        };
        const wf = this.opts.workflows.find((w) => w.id === rec.workflowId);
        if (wf === undefined) continue;
        await this.ledger.append('job.recovered', { runId: rec.runId, workflow: rec.workflowId });
        this.enqueue({ runId: rec.runId, wf, event: rec.event, key: rec.key });
      } catch {
        await rename(join(dir, f), join(dir, `${f}.corrupt`)).catch(() => undefined);
      }
    }
  }

  private async acceptTracked(wf: WorkflowDefinition, event: TriggerEvent): Promise<EmitResult> {
    this.accepting++;
    try {
      return await this.accept(wf, event);
    } finally {
      this.accepting--;
      this.signalIdle();
    }
  }

  private signalIdle(): void {
    if (this.active === 0 && this.queue.length === 0 && this.accepting === 0) for (const w of this.idleWaiters.splice(0)) w();
  }

  private async accept(wf: WorkflowDefinition, event: TriggerEvent): Promise<EmitResult> {
    if (this.stopped) return { accepted: false, reason: 'stopped' };
    const key = `${wf.id}:${event.idempotencyKey}`;
    if (this.seen.has(key)) {
      this.counters.duplicates++;
      await this.ledger.append('job.duplicate', { workflow: wf.id, key });
      void event.onSettled?.('duplicate');
      return { accepted: false, duplicate: true };
    }
    if (this.queue.length >= (this.opts.maxQueue ?? 1000)) return { accepted: false, reason: 'queue_full' };
    if (wf.maxRunsPerMinute !== undefined) {
      const t = this.now().getTime();
      const win = (this.recent.get(wf.id) ?? []).filter((x) => t - x < 60_000);
      if (win.length >= wf.maxRunsPerMinute) return { accepted: false, reason: 'rate_limited' };
      win.push(t);
      this.recent.set(wf.id, win);
    }
    const runId = `run_${randomUUID().slice(0, 12)}`;
    this.seen.add(key);
    const { onSettled: _omit, ...persistable } = event;
    void _omit;
    // persist BEFORE acknowledging, so an accepted event can never be lost
    await writeFile(
      join(this.opts.dir, 'state/pending', `${runId}.json`),
      JSON.stringify({ runId, workflowId: wf.id, key, event: persistable }),
      'utf8',
    );
    await this.ledger.append('job.accepted', {
      runId,
      workflow: wf.id,
      key,
      source: event.source,
      trigger: event.trigger,
      payloadHash: h(event.payload),
    });
    this.counters.accepted++;
    this.enqueue({ runId, wf, event, key });
    return { accepted: true, runId };
  }

  private enqueue(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.active < (this.opts.concurrency ?? 4) && this.queue.length > 0) {
      const job = this.queue.shift() as Job;
      this.active++;
      void this.execute(job).finally(() => {
        this.active--;
        this.pump();
        this.signalIdle();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const max = job.wf.maxAttempts ?? 3;
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= max; attempt++) {
      await this.ledger.append('job.started', { runId: job.runId, attempt });
      try {
        const out = await job.wf.run(job.event, { runId: job.runId, attempt, workflowId: job.wf.id });
        await this.writeOutbox(job, out);
        await this.ledger.append('job.completed', {
          runId: job.runId,
          workflow: job.wf.id,
          disposition: out.disposition,
          lane: out.lane,
          summary: out.summary,
          outputHash: h(out.output ?? null),
        });
        await rm(join(this.opts.dir, 'state/pending', `${job.runId}.json`), { force: true });
        this.counters.completed++;
        await job.event.onSettled?.('completed');
        return;
      } catch (e) {
        lastError = (e as Error).message;
        const permanent = e instanceof PermanentError;
        if (permanent || attempt === max) break;
        this.counters.retries++;
        await this.ledger.append('job.retry', { runId: job.runId, attempt, error: lastError });
        await this.sleep((this.opts.backoffBaseMs ?? 500) * 2 ** (attempt - 1));
      }
    }
    await this.writeOutbox(job, {
      disposition: 'rejected',
      lane: 'dead-letter',
      summary: `failed: ${lastError}`,
      output: { error: lastError, payload: job.event.payload },
    });
    await this.ledger.append('job.failed', { runId: job.runId, workflow: job.wf.id, error: lastError });
    await rm(join(this.opts.dir, 'state/pending', `${job.runId}.json`), { force: true });
    this.counters.failed++;
    await job.event.onSettled?.('failed');
  }

  private async writeOutbox(job: Job, out: WorkflowOutcome): Promise<void> {
    const lane = out.lane.replace(/[^A-Za-z0-9_\-/ ]/g, '_').replace(/\.\./g, '_');
    const dir = join(this.opts.dir, 'outbox', lane);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${job.runId}.tmp`);
    await writeFile(
      tmp,
      JSON.stringify(
        {
          runId: job.runId,
          workflow: job.wf.id,
          at: this.now().toISOString(),
          disposition: out.disposition,
          summary: out.summary,
          output: out.output,
          trigger: { id: job.event.trigger, source: job.event.source },
        },
        null,
        2,
      ),
      'utf8',
    );
    await rename(tmp, join(dir, `${job.runId}.json`)); // atomic: readers never see half a file
  }

  /** Resolves when no work is queued or running. */
  idle(): Promise<void> {
    return this.active === 0 && this.queue.length === 0 && this.accepting === 0
      ? Promise.resolve()
      : new Promise((r) => this.idleWaiters.push(r));
  }

  /** Stops intake, lets in-flight work finish, then closes. Pending-but-unstarted work stays persisted and is recovered next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.opts.workflows.flatMap((w) => w.triggers.map((t) => t.stop())));
    await this.idle();
    await this.ledger.append('engine.stopped', { counters: this.counters });
  }
}
