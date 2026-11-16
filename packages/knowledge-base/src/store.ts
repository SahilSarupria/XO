/**
 * Tenant-scoped, append-only persistence for the BKB (spec §4.6 "Persistence, versioning and integrity").
 *
 * Layout under `<root>/<tenantId>/`:
 *   records/<id>.json          immutable record content (a record id is derived from its content; rewriting it with
 *                              different content is refused as an integrity violation)
 *   change-sets/<id>.json      immutable proposals
 *   decisions/<id>.json        the decision on a change set (approve / reject), written once
 *   states/<id>.json           immutable knowledge-state manifests
 *   packs/<hex>.json           installed Domain Knowledge Pack artifacts, by digest
 *   events.jsonl               the hash-chained event log; the head state is derived from it, never stored as a mutable flag
 *
 * Nothing is ever overwritten or deleted. Writes go to a temporary file and are renamed into place, so a crash leaves
 * either the old file or the new one. Every tenant has its own directory; a store is bound to one tenant and refuses
 * records that name another. This is the canonical store; retrieval indexes are derived from it and rebuildable.
 *
 * Storage choice (ADR 0029 decision 16, spec §4.6 "do not introduce a new database category without a decision"): plain
 * files, as every other XO store in the data directory (`XO_DATA_DIR`, UW-17), so backup, verify and restore cover the BKB
 * with no new infrastructure. A database adapter can implement `KnowledgeStore` later behind the same interface.
 */
import { mkdir, readFile, readdir, rename, writeFile, appendFile, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digestOf, type Digest } from './canonical.js';
import type { ChangeSet, KnowledgeEvent, KnowledgeRecord, KnowledgeState } from './types.js';
import type { PackArtifact } from './packs.js';

const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ID = /^[a-z]{2,4}_[0-9a-f]{24}$/;

export interface ChangeSetDecision {
  readonly changeSetId: string;
  readonly status: 'approved' | 'rejected';
  readonly by: { readonly id: string; readonly kind: string };
  readonly at: string;
  readonly reason: string;
  readonly resultingStateId?: string;
}

export interface KnowledgeStore {
  readonly tenantId: string;
  putRecord(record: KnowledgeRecord): Promise<void>;
  getRecord(id: string): Promise<KnowledgeRecord | undefined>;
  /** Every record of the tenant (for migration, backup checks and audits). */
  listRecords(): Promise<readonly KnowledgeRecord[]>;
  putChangeSet(changeSet: ChangeSet): Promise<void>;
  getChangeSet(id: string): Promise<ChangeSet | undefined>;
  listChangeSets(): Promise<readonly ChangeSet[]>;
  putDecision(decision: ChangeSetDecision): Promise<void>;
  getDecision(changeSetId: string): Promise<ChangeSetDecision | undefined>;
  putState(state: KnowledgeState): Promise<void>;
  getState(id: string): Promise<KnowledgeState | undefined>;
  listStates(): Promise<readonly KnowledgeState[]>;
  putPack(pack: PackArtifact): Promise<void>;
  listPacks(): Promise<readonly PackArtifact[]>;
  appendEvent(event: Omit<KnowledgeEvent, 'seq' | 'prevDigest' | 'digest' | 'tenantId'>): Promise<KnowledgeEvent>;
  events(): Promise<readonly KnowledgeEvent[]>;
  /**
   * Runs `fn` with exclusive write access to this tenant's knowledge: across processes and machines for the SQL stores (a
   * transaction holding the tenant lock), across processes on one filesystem for the file store (a lock file). Every
   * read-check-write sequence of the BKB (propose, approve, reject, install) runs inside it, so two reviewers can never
   * both approve against the same head.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Releases connections and flushes; the store is unusable afterwards. */
  close(): Promise<void>;
}

export class IntegrityError extends Error {}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new IntegrityError(`unreadable ${path}: ${(e as Error).message}`);
  }
}

export class FsKnowledgeStore implements KnowledgeStore {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    root: string,
    readonly tenantId: string,
  ) {
    this.dir = join(root, tenantId);
  }

  static async open(root: string, tenantId: string): Promise<FsKnowledgeStore> {
    if (!TENANT.test(tenantId)) throw new Error('a tenant id is 1-64 letters, digits, "-" or "_"');
    const store = new FsKnowledgeStore(root, tenantId);
    for (const sub of ['records', 'change-sets', 'decisions', 'states', 'packs']) await mkdir(join(store.dir, sub), { recursive: true });
    return store;
  }

  private path(sub: string, id: string): string {
    if (!SAFE_ID.test(id) && !/^[0-9a-f]{64}$/.test(id)) throw new IntegrityError(`malformed id "${id}"`);
    return join(this.dir, sub, `${id}.json`);
  }

  private checkTenant(tenantId: string, what: string): void {
    if (tenantId !== this.tenantId) throw new IntegrityError(`${what} belongs to tenant "${tenantId}", not "${this.tenantId}"`);
  }

  async putRecord(record: KnowledgeRecord): Promise<void> {
    this.checkTenant(record.tenantId, `record ${record.id}`);
    const path = this.path('records', record.id);
    const existing = await readJson<KnowledgeRecord>(path);
    if (existing !== undefined) {
      if (digestOf(existing) !== digestOf(record)) throw new IntegrityError(`record ${record.id} already exists with different content`);
      return;
    }
    await atomicWrite(path, JSON.stringify(record));
  }

  async getRecord(id: string): Promise<KnowledgeRecord | undefined> {
    const r = await readJson<KnowledgeRecord>(this.path('records', id));
    if (r !== undefined) this.checkTenant(r.tenantId, `record ${id}`);
    return r;
  }

  async listRecords(): Promise<readonly KnowledgeRecord[]> {
    return this.listDir<KnowledgeRecord>('records');
  }

  async putChangeSet(changeSet: ChangeSet): Promise<void> {
    this.checkTenant(changeSet.tenantId, `change set ${changeSet.changeSetId}`);
    const path = this.path('change-sets', changeSet.changeSetId);
    if ((await readJson(path)) !== undefined) return; // content-derived id: the same proposal twice is one proposal
    await atomicWrite(path, JSON.stringify(changeSet));
  }

  async getChangeSet(id: string): Promise<ChangeSet | undefined> {
    const c = await readJson<ChangeSet>(this.path('change-sets', id));
    if (c !== undefined) this.checkTenant(c.tenantId, `change set ${id}`);
    return c;
  }

  async listChangeSets(): Promise<readonly ChangeSet[]> {
    return this.listDir<ChangeSet>('change-sets');
  }

  async putDecision(decision: ChangeSetDecision): Promise<void> {
    const path = this.path('decisions', decision.changeSetId);
    if ((await readJson(path)) !== undefined) throw new IntegrityError(`change set ${decision.changeSetId} is already decided`);
    await atomicWrite(path, JSON.stringify(decision));
  }

  async getDecision(changeSetId: string): Promise<ChangeSetDecision | undefined> {
    return readJson<ChangeSetDecision>(this.path('decisions', changeSetId));
  }

  async putState(state: KnowledgeState): Promise<void> {
    this.checkTenant(state.tenantId, `state ${state.stateId}`);
    const path = this.path('states', state.stateId);
    const existing = await readJson<KnowledgeState>(path);
    if (existing !== undefined) {
      if (existing.digest !== state.digest) throw new IntegrityError(`state ${state.stateId} already exists with a different digest`);
      return;
    }
    await atomicWrite(path, JSON.stringify(state));
  }

  async getState(id: string): Promise<KnowledgeState | undefined> {
    const s = await readJson<KnowledgeState>(this.path('states', id));
    if (s !== undefined) this.checkTenant(s.tenantId, `state ${id}`);
    return s;
  }

  async listStates(): Promise<readonly KnowledgeState[]> {
    return this.listDir<KnowledgeState>('states');
  }

  async putPack(pack: PackArtifact): Promise<void> {
    const path = this.path('packs', pack.digest.slice(7));
    if ((await readJson(path)) !== undefined) return;
    await atomicWrite(path, JSON.stringify(pack));
  }

  async listPacks(): Promise<readonly PackArtifact[]> {
    return this.listDir<PackArtifact>('packs');
  }

  private exclusiveChain: Promise<unknown> = Promise.resolve();

  /** In-process serialization plus a lock file (`O_EXCL`) for other processes on the same filesystem. A lock older than 60 s is stale. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.exclusiveChain.then(async () => {
      const lockPath = join(this.dir, '.write.lock');
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          const h = await open(lockPath, 'wx');
          await h.writeFile(`${process.pid}\n`);
          await h.close();
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          const st = await stat(lockPath).catch(() => undefined);
          if (st !== undefined && Date.now() - st.mtimeMs > 60_000) await unlink(lockPath).catch(() => undefined);
          if (Date.now() > deadline)
            throw new IntegrityError(`the knowledge store of tenant "${this.tenantId}" is locked by another writer`);
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      try {
        return await fn();
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    });
    this.exclusiveChain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.exclusiveChain;
  }

  /** Appends one event, chained to the previous one by digest. Serialized within the process. */
  appendEvent(event: Omit<KnowledgeEvent, 'seq' | 'prevDigest' | 'digest' | 'tenantId'>): Promise<KnowledgeEvent> {
    const next = this.chain.then(async () => {
      const all = await this.events();
      const prev = all[all.length - 1];
      const body = { ...event, tenantId: this.tenantId, seq: all.length + 1, prevDigest: prev?.digest ?? null };
      const full: KnowledgeEvent = { ...body, digest: digestOf(body) as Digest };
      await appendFile(join(this.dir, 'events.jsonl'), `${JSON.stringify(full)}\n`);
      return full;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The event log, with its chain verified: a broken link or an edited event is an integrity error. */
  async events(): Promise<readonly KnowledgeEvent[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir, 'events.jsonl'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: KnowledgeEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const ev = JSON.parse(line) as KnowledgeEvent;
      const { digest, ...body } = ev;
      if (digestOf(body) !== digest) throw new IntegrityError(`event ${ev.seq} was altered`);
      if (ev.prevDigest !== (out[out.length - 1]?.digest ?? null) || ev.seq !== out.length + 1)
        throw new IntegrityError(`the event log is broken at event ${ev.seq}`);
      if (ev.tenantId !== this.tenantId) throw new IntegrityError(`event ${ev.seq} belongs to another tenant`);
      out.push(ev);
    }
    return out;
  }

  private async listDir<T>(sub: string): Promise<readonly T[]> {
    const names = (await readdir(join(this.dir, sub))).filter((n) => n.endsWith('.json')).sort();
    const out: T[] = [];
    for (const n of names) {
      const v = await readJson<T>(join(this.dir, sub, n));
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}
