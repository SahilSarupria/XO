import { createHash, randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import { MAX_CASES_PER_CAPABILITY, MAX_RUNS_PER_CASE, type TestCase, type TestCaseInput, type TestCaseRun } from './test-case.js';

export const TEST_CASE_ID = /^tc_[0-9a-f]{32}$/;
const queues = new Map<string, Promise<unknown>>();

/** Grouping key for a capability: ids may contain characters a storage key should not, so the key is a digest. */
const group = (compilationId: string, capabilityId: string) =>
  createHash('sha256').update(`${compilationId}\u0000${capabilityId}`).digest('hex').slice(0, 32);
const caseKey = (g: string, id: string) => `test-cases/${g}/${id}.json`;
const runPrefix = (caseId: string) => `test-case-runs/${caseId}/`;

export class StaleTestCaseError extends XoError {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.PRECONDITION_FAILED,
      `this test case was changed by someone else (expected revision ${expected}, current is ${actual}); reload and retry`,
      {
        context: { expectedRevision: expected, currentRevision: actual, reason: 'stale_revision' },
      },
    );
  }
}

/** Test cases live in the workspace's own state store, so they stay wherever the workspace's data already is. */
export class FsTestCaseStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  private locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const k = `${this.workspaceId}/${id}`;
    const run = (queues.get(k) ?? Promise.resolve()).then(work);
    queues.set(
      k,
      run.catch(() => undefined),
    );
    return run;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await this.store.get(key);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as T;
    } catch {
      return undefined;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    const r = await this.store.put(key, JSON.stringify(value), { contentType: 'application/json' });
    if (!r.ok) throw r.error;
  }

  private async keys(prefix: string): Promise<string[]> {
    const listed = await this.store.list(prefix);
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    return [...listed.value];
  }

  async list(compilationId: string, capabilityId: string): Promise<readonly TestCase[]> {
    const g = group(compilationId, capabilityId);
    const out: TestCase[] = [];
    for (const k of await this.keys(`test-cases/${g}/`)) {
      const c = await this.read<TestCase>(k);
      if (c !== undefined) out.push(c);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.caseId < b.caseId ? -1 : 1));
  }

  async get(compilationId: string, capabilityId: string, caseId: string): Promise<TestCase | undefined> {
    if (!TEST_CASE_ID.test(caseId)) return undefined;
    return this.read<TestCase>(caseKey(group(compilationId, capabilityId), caseId));
  }

  async create(compilationId: string, capabilityId: string, input: TestCaseInput, by: string, now: Date): Promise<TestCase> {
    const g = group(compilationId, capabilityId);
    return this.locked(g, async () => {
      if ((await this.list(compilationId, capabilityId)).length >= MAX_CASES_PER_CAPABILITY)
        throw new XoError(
          ErrorCode.INVALID_ARGUMENT,
          `a capability can have at most ${MAX_CASES_PER_CAPABILITY} saved test cases; delete one first`,
        );
      const c: TestCase = {
        caseId: `tc_${randomUUID().replace(/-/g, '')}`,
        workspaceId: this.workspaceId,
        compilationId,
        capabilityId,
        ...input,
        revision: 1,
        createdAt: now.toISOString(),
        createdBy: by,
        updatedAt: now.toISOString(),
        updatedBy: by,
      };
      await this.write(caseKey(g, c.caseId), c);
      return c;
    });
  }

  replace(
    compilationId: string,
    capabilityId: string,
    caseId: string,
    input: TestCaseInput,
    expectedRevision: number | undefined,
    by: string,
    now: Date,
  ): Promise<TestCase | undefined> {
    return this.locked(caseId, async () => {
      const current = await this.get(compilationId, capabilityId, caseId);
      if (current === undefined) return undefined;
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new StaleTestCaseError(expectedRevision, current.revision);
      const next: TestCase = { ...current, ...input, revision: current.revision + 1, updatedAt: now.toISOString(), updatedBy: by };
      await this.write(caseKey(group(compilationId, capabilityId), caseId), next);
      return next;
    });
  }

  delete(compilationId: string, capabilityId: string, caseId: string): Promise<boolean> {
    return this.locked(caseId, async () => {
      if ((await this.get(compilationId, capabilityId, caseId)) === undefined) return false;
      const del = await this.store.delete(caseKey(group(compilationId, capabilityId), caseId));
      if (!del.ok) throw del.error;
      for (const k of await this.keys(runPrefix(caseId))) await this.store.delete(k);
      return true;
    });
  }

  async addRun(run: TestCaseRun): Promise<void> {
    await this.locked(run.caseId, async () => {
      await this.write(`${runPrefix(run.caseId)}${String(Date.parse(run.at)).padStart(15, '0')}_${run.runId}.json`, run);
      const keys = (await this.keys(runPrefix(run.caseId))).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RUNS_PER_CASE))) await this.store.delete(k);
    });
  }

  /** Newest first. */
  async runs(caseId: string): Promise<readonly TestCaseRun[]> {
    const out: TestCaseRun[] = [];
    for (const k of (await this.keys(runPrefix(caseId))).sort().reverse()) {
      const r = await this.read<TestCaseRun>(k);
      if (r !== undefined) out.push(r);
    }
    return out;
  }
}
