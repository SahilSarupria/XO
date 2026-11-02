import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex, type FieldSpec, type Scalar } from '@xo/workflow-ir';

export interface UsageLimits {
  /** Max side-effecting calls per UTC day across all runs sharing this directory. */
  readonly effectsPerDay?: number;
  readonly modelCallsPerDay?: number;
}

/**
 * Daily call caps, persisted so a restart cannot reset them. Counters live in `<dir>/usage-YYYY-MM-DD.json`, updated
 * atomically and serialized in-process. A counter file that cannot be read or parsed throws: callers treat that as
 * "cap unknown" and escalate (fail closed). Single process; two processes sharing a directory can overshoot.
 */
export class UsageCaps {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly limits: UsageLimits,
    private readonly now: () => number = Date.now,
  ) {}

  consume(kind: 'effects' | 'modelCalls', n = 1): Promise<boolean> {
    const run = this.chain.then(() => this.consumeNow(kind, n));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async consumeNow(kind: 'effects' | 'modelCalls', n: number): Promise<boolean> {
    const limit = kind === 'effects' ? this.limits.effectsPerDay : this.limits.modelCallsPerDay;
    if (limit === undefined) return true;
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `usage-${new Date(this.now()).toISOString().slice(0, 10)}.json`);
    let counts: Record<string, number> = {};
    try {
      counts = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
      if (typeof counts !== 'object' || counts === null || Object.values(counts).some((v) => !Number.isInteger(v) || v < 0))
        throw new Error('bad counter file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`usage counters unreadable: ${(e as Error).message}`);
    }
    const used = counts[kind] ?? 0;
    if (used + n > limit) return false;
    counts[kind] = used + n;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(counts));
    await rename(tmp, file);
    return true;
  }
}

/** Persists validated extraction results keyed by the normalized case, so an identical case never calls the model twice. */
export class ExtractionMemo {
  constructor(private readonly dir: string) {}

  static key(instruction: string, fields: Readonly<Record<string, FieldSpec>>, text: string): string {
    return sha256Hex(canonicalJson({ i: instruction, f: fields, t: text.trim().replace(/\s+/g, ' ') }));
  }

  async get(key: string): Promise<Record<string, Scalar> | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as Record<string, Scalar>;
    } catch {
      return undefined; // a missing or damaged entry is a miss, never a wrong answer
    }
  }

  async set(key: string, facts: Readonly<Record<string, Scalar>>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${key}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(facts));
    await rename(tmp, join(this.dir, `${key}.json`));
  }
}
