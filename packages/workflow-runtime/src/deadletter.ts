import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@xo/workflow-ir';

/**
 * A step that ended without succeeding (retries exhausted, or escalated/failed outright) is stored here AND the run is escalated or failed
 * as before. The record is evidence for a person; it is never a way to drop work, and writing it must not be skipped silently: if the store
 * cannot persist, the error propagates (a crash, so the run resumes from its journal) rather than the failure going unrecorded.
 */
export interface DeadLetter {
  readonly id: string;
  readonly runId: string;
  readonly workflow: string;
  readonly version: string;
  readonly step: string;
  readonly code: string;
  readonly message: string;
  readonly attempts: number;
  /** What the run did with it. */
  readonly disposition: 'failed' | 'escalated';
  readonly at: string;
  /** Hash of the request that would be re-sent, when the step called a connector. Arguments themselves are not stored (they may hold personal data or secrets). */
  readonly requestHash?: string;
  /** forEach item index, when the step belonged to an item. */
  readonly itemIndex?: number;
}

export interface DeadLetterStore {
  put(d: Omit<DeadLetter, 'id'>): Promise<DeadLetter>;
  list(): Promise<DeadLetter[]>;
}

/** Deterministic id: the same failure recorded twice (a resume after a crash between the write and the journal) is one record, not two. */
export function deadLetterId(runId: string, step: string, code: string, attempts: number): string {
  return `dl_${sha256Hex(canonicalJson({ r: runId, s: step, c: code, a: attempts })).slice(0, 32)}`;
}

/** One JSON file per record under `<dir>`, written atomically. */
export class FileDeadLetterStore implements DeadLetterStore {
  constructor(private readonly dir: string) {}

  async put(d: Omit<DeadLetter, 'id'>): Promise<DeadLetter> {
    const rec: DeadLetter = { ...d, id: deadLetterId(d.runId, d.step, d.code, d.attempts) };
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${rec.id}.json`);
    const tmp = join(this.dir, `.${rec.id}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(rec));
    await rename(tmp, file); // same id => same content: overwriting is idempotent
    return rec;
  }

  async list(): Promise<DeadLetter[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: DeadLetter[] = [];
    for (const n of names.filter((x) => /^dl_[0-9a-f]{32}\.json$/.test(x)).sort()) {
      out.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as DeadLetter); // a damaged record is an error, not a silent omission
    }
    return out;
  }
}

/** In-memory store for tests and embedding. */
export class MemoryDeadLetterStore implements DeadLetterStore {
  private readonly items = new Map<string, DeadLetter>();
  async put(d: Omit<DeadLetter, 'id'>): Promise<DeadLetter> {
    const rec: DeadLetter = { ...d, id: deadLetterId(d.runId, d.step, d.code, d.attempts) };
    this.items.set(rec.id, rec);
    return rec;
  }
  async list(): Promise<DeadLetter[]> {
    return [...this.items.values()];
  }
}
