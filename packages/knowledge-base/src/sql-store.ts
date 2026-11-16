/**
 * The BKB on a SQL database (ADR 0029 decision 16, extended by ADR 0030): the same `KnowledgeStore` contract as the file store,
 * with the database providing atomicity, durability and multi-writer safety.
 *
 *   - Every row is keyed by tenant; a store bound to one tenant can neither read nor write another's rows.
 *   - Records, change sets, decisions, states and packs are write-once: a second write of the same id with different content
 *     is refused as an integrity violation (never an update).
 *   - Events are hash-chained per tenant; reads verify the chain and every record digest, so a row altered in the database is
 *     detected, not trusted.
 *   - `exclusive` is a transaction that holds the tenant's write lock (SQLite `BEGIN IMMEDIATE`; PostgreSQL a transaction-scoped
 *     advisory lock), so propose/approve/reject are serialised across processes and machines.
 *
 * Drivers: `sqliteDriver` (built in, `node:sqlite`, one file — a self-hosted instance) and the PostgreSQL driver in
 * `@xo/knowledge-store-postgres` (a hosted, multi-node service). Both run the same conformance suite.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { digestOf, type Digest } from './canonical.js';
import type { PackArtifact } from './packs.js';
import { stateContentRoot, StaleHeadError, type HeadPointer } from './state-root.js';
import { IntegrityError, type ChangeSetDecision, type KnowledgeStore } from './store.js';
import type { ChangeSet, KnowledgeEvent, KnowledgeRecord, KnowledgeState } from './types.js';

export type SqlValue = string | number | null;

/** The minimum a SQL engine must offer. Placeholders are `?`; a driver translates them to its own syntax. */
export interface SqlDriver {
  readonly dialect: 'sqlite' | 'postgres';
  query<T extends Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /**
   * Runs `fn` in one transaction on one connection, holding the write lock named by `lockKey` until commit or rollback.
   * Statements issued through the `tx` driver passed to `fn` are part of the transaction.
   */
  transaction<T>(lockKey: string, fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Schema history (each step runs once, in order, under the schema lock, in one transaction with the version bump):
 *   1  write-once tables keyed by (tenant, id) and the hash-chained event log (ADR 0029/0030).
 *   2  UW-4b (ADR 0034): `kb_heads`, the compare-and-swap head pointer with the state's content root, backfilled from each
 *      tenant's event log; `kb_indexes`, persisted retrieval indexes keyed by state id (derived data, rebuildable).
 */
export const KNOWLEDGE_SCHEMA_VERSION = 2;

const V1_TABLES = ['kb_records', 'kb_change_sets', 'kb_decisions', 'kb_states', 'kb_packs'] as const;
/** Every write-once (tenant, id) table: the schema-1 ones and schema 2's `kb_indexes`. */
type Table = (typeof V1_TABLES)[number] | 'kb_indexes';

/** Creates the schema (idempotent) and refuses a database written by a newer schema. */
export async function migrateKnowledgeSchema(driver: SqlDriver): Promise<void> {
  // Under the schema lock: many processes may start at once, and DDL racing DDL is an error on PostgreSQL.
  await driver.transaction('xo-kb:schema', (tx) => migrateLocked(tx));
}

async function migrateLocked(driver: SqlDriver): Promise<void> {
  const text = driver.dialect === 'postgres' ? 'TEXT' : 'TEXT';
  const int = driver.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await driver.run(`CREATE TABLE IF NOT EXISTS kb_schema (version ${int} NOT NULL)`);
  const rows = await driver.query<{ version: number | string }>('SELECT version FROM kb_schema');
  const current = rows.length === 0 ? 0 : Number(rows[0]!.version);
  if (current > KNOWLEDGE_SCHEMA_VERSION)
    throw new IntegrityError(
      `the knowledge database was written by a newer XO (schema ${current}; this build knows ${KNOWLEDGE_SCHEMA_VERSION})`,
    );
  if (current < 1) {
    for (const t of V1_TABLES)
      await driver.run(
        `CREATE TABLE IF NOT EXISTS ${t} (tenant ${text} NOT NULL, id ${text} NOT NULL, body ${text} NOT NULL, digest ${text} NOT NULL, PRIMARY KEY (tenant, id))`,
      );
    await driver.run(
      `CREATE TABLE IF NOT EXISTS kb_events (tenant ${text} NOT NULL, seq ${int} NOT NULL, body ${text} NOT NULL, digest ${text} NOT NULL, PRIMARY KEY (tenant, seq))`,
    );
  }
  if (current < 2) {
    await driver.run(
      `CREATE TABLE IF NOT EXISTS kb_heads (tenant ${text} NOT NULL PRIMARY KEY, state_id ${text} NOT NULL, content_root ${text} NOT NULL, event_seq ${int} NOT NULL)`,
    );
    await driver.run(
      `CREATE TABLE IF NOT EXISTS kb_indexes (tenant ${text} NOT NULL, id ${text} NOT NULL, body ${text} NOT NULL, digest ${text} NOT NULL, PRIMARY KEY (tenant, id))`,
    );
    if (current === 1) await backfillHeads(driver);
  }
  if (current === 0) await driver.run('INSERT INTO kb_schema (version) VALUES (?)', [KNOWLEDGE_SCHEMA_VERSION]);
  else if (current < KNOWLEDGE_SCHEMA_VERSION) await driver.run('UPDATE kb_schema SET version = ?', [KNOWLEDGE_SCHEMA_VERSION]);
}

/**
 * Schema 1 → 2: every tenant's head pointer, from the last `state.created` event of its (verified) log. The state it names must
 * exist and match the event's digest; anything else stops the migration (the transaction rolls back and schema 1 stays).
 */
async function backfillHeads(driver: SqlDriver): Promise<void> {
  const tenants = await driver.query<{ tenant: string }>('SELECT DISTINCT tenant FROM kb_events ORDER BY tenant');
  for (const { tenant } of tenants) {
    const rows = await driver.query<{ seq: number | string; body: string; digest: string }>(
      'SELECT seq, body, digest FROM kb_events WHERE tenant = ? ORDER BY seq',
      [tenant],
    );
    let prev: string | null = null;
    let head: { seq: number; stateId: string; stateDigest: string } | undefined;
    for (const row of rows) {
      const ev = JSON.parse(row.body) as KnowledgeEvent;
      const { digest, ...body } = ev;
      if (digestOf(body) !== digest || digest !== row.digest || ev.prevDigest !== prev)
        throw new IntegrityError(`migration to schema 2: tenant "${tenant}" event ${row.seq} does not verify`);
      prev = digest;
      if (ev.type === 'state.created') head = { seq: Number(row.seq), stateId: ev.subjectId, stateDigest: ev.subjectDigest };
    }
    if (head === undefined) continue;
    const st = await driver.query<{ body: string; digest: string }>('SELECT body, digest FROM kb_states WHERE tenant = ? AND id = ?', [
      tenant,
      head.stateId,
    ]);
    const state = st[0] === undefined ? undefined : (JSON.parse(st[0].body) as KnowledgeState);
    if (state === undefined || digestOf(state) !== st[0]!.digest || state.digest !== head.stateDigest)
      throw new IntegrityError(`migration to schema 2: tenant "${tenant}" head state ${head.stateId} is missing or altered`);
    await driver.run('INSERT INTO kb_heads (tenant, state_id, content_root, event_seq) VALUES (?, ?, ?, ?)', [
      tenant,
      head.stateId,
      stateContentRoot(state),
      head.seq,
    ]);
  }
}

const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

export class SqlKnowledgeStore implements KnowledgeStore {
  private readonly tx = new AsyncLocalStorage<SqlDriver>();

  private constructor(
    private readonly driver: SqlDriver,
    readonly tenantId: string,
    private readonly ownsDriver: boolean,
  ) {}

  /** Opens the store for one tenant (running migrations). With `ownsDriver`, `close()` closes the driver too. */
  static async open(driver: SqlDriver, tenantId: string, options: { readonly ownsDriver?: boolean } = {}): Promise<SqlKnowledgeStore> {
    if (!TENANT.test(tenantId)) throw new Error('a tenant id is 1-64 letters, digits, "-" or "_"');
    await migrateKnowledgeSchema(driver);
    return new SqlKnowledgeStore(driver, tenantId, options.ownsDriver === true);
  }

  private get db(): SqlDriver {
    return this.tx.getStore() ?? this.driver;
  }

  private checkTenant(tenantId: string, what: string): void {
    if (tenantId !== this.tenantId) throw new IntegrityError(`${what} belongs to tenant "${tenantId}", not "${this.tenantId}"`);
  }

  private async putOnce(table: Table, id: string, value: unknown, what: string): Promise<void> {
    const body = JSON.stringify(value);
    const digest = digestOf(value);
    await this.db.run(`INSERT INTO ${table} (tenant, id, body, digest) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, id) DO NOTHING`, [
      this.tenantId,
      id,
      body,
      digest,
    ]);
    const rows = await this.db.query<{ digest: string }>(`SELECT digest FROM ${table} WHERE tenant = ? AND id = ?`, [this.tenantId, id]);
    if (rows[0]?.digest !== digest) throw new IntegrityError(`${what} ${id} already exists with different content`);
  }

  private async getOne<T>(table: Table, id: string, what: string): Promise<T | undefined> {
    const rows = await this.db.query<{ body: string; digest: string }>(`SELECT body, digest FROM ${table} WHERE tenant = ? AND id = ?`, [
      this.tenantId,
      id,
    ]);
    const row = rows[0];
    if (row === undefined) return undefined;
    let value: T;
    try {
      value = JSON.parse(row.body) as T;
    } catch {
      throw new IntegrityError(`${what} ${id} is unreadable`);
    }
    if (digestOf(value) !== row.digest) throw new IntegrityError(`${what} ${id} was altered in the database`);
    return value;
  }

  private async listAll<T>(table: Table, what: string): Promise<readonly T[]> {
    const rows = await this.db.query<{ id: string; body: string; digest: string }>(
      `SELECT id, body, digest FROM ${table} WHERE tenant = ? ORDER BY id`,
      [this.tenantId],
    );
    return rows.map((r) => {
      const v = JSON.parse(r.body) as T;
      if (digestOf(v) !== r.digest) throw new IntegrityError(`${what} ${r.id} was altered in the database`);
      return v;
    });
  }

  async putRecord(record: KnowledgeRecord): Promise<void> {
    this.checkTenant(record.tenantId, `record ${record.id}`);
    await this.putOnce('kb_records', record.id, record, 'record');
  }
  async getRecord(id: string): Promise<KnowledgeRecord | undefined> {
    const r = await this.getOne<KnowledgeRecord>('kb_records', id, 'record');
    if (r !== undefined) this.checkTenant(r.tenantId, `record ${id}`);
    return r;
  }
  listRecords(): Promise<readonly KnowledgeRecord[]> {
    return this.listAll<KnowledgeRecord>('kb_records', 'record');
  }
  async putChangeSet(changeSet: ChangeSet): Promise<void> {
    this.checkTenant(changeSet.tenantId, `change set ${changeSet.changeSetId}`);
    await this.putOnce('kb_change_sets', changeSet.changeSetId, changeSet, 'change set');
  }
  getChangeSet(id: string): Promise<ChangeSet | undefined> {
    return this.getOne<ChangeSet>('kb_change_sets', id, 'change set');
  }
  listChangeSets(): Promise<readonly ChangeSet[]> {
    return this.listAll<ChangeSet>('kb_change_sets', 'change set');
  }
  async putDecision(decision: ChangeSetDecision): Promise<void> {
    const existing = await this.getDecision(decision.changeSetId);
    if (existing !== undefined) throw new IntegrityError(`change set ${decision.changeSetId} is already decided`);
    await this.putOnce('kb_decisions', decision.changeSetId, decision, 'decision');
  }
  getDecision(changeSetId: string): Promise<ChangeSetDecision | undefined> {
    return this.getOne<ChangeSetDecision>('kb_decisions', changeSetId, 'decision');
  }
  async putState(state: KnowledgeState): Promise<void> {
    this.checkTenant(state.tenantId, `state ${state.stateId}`);
    const existing = await this.getOne<KnowledgeState>('kb_states', state.stateId, 'state');
    if (existing !== undefined && existing.digest !== state.digest)
      throw new IntegrityError(`state ${state.stateId} already exists with a different digest`);
    if (existing === undefined) await this.putOnce('kb_states', state.stateId, state, 'state');
  }
  getState(id: string): Promise<KnowledgeState | undefined> {
    return this.getOne<KnowledgeState>('kb_states', id, 'state');
  }
  listStates(): Promise<readonly KnowledgeState[]> {
    return this.listAll<KnowledgeState>('kb_states', 'state');
  }
  async putPack(pack: PackArtifact): Promise<void> {
    if ((await this.getOne('kb_packs', pack.digest, 'pack')) === undefined) await this.putOnce('kb_packs', pack.digest, pack, 'pack');
  }
  listPacks(): Promise<readonly PackArtifact[]> {
    return this.listAll<PackArtifact>('kb_packs', 'pack');
  }

  async appendEvent(event: Omit<KnowledgeEvent, 'seq' | 'prevDigest' | 'digest' | 'tenantId'>): Promise<KnowledgeEvent> {
    if (this.tx.getStore() === undefined) return this.exclusive(() => this.appendEvent(event));
    const last = await this.db.query<{ seq: number | string; digest: Digest }>(
      'SELECT seq, digest FROM kb_events WHERE tenant = ? ORDER BY seq DESC LIMIT 1',
      [this.tenantId],
    );
    const prev = last[0];
    const body = {
      ...event,
      tenantId: this.tenantId,
      seq: prev === undefined ? 1 : Number(prev.seq) + 1,
      prevDigest: prev?.digest ?? null,
    };
    const full: KnowledgeEvent = { ...body, digest: digestOf(body) as Digest };
    await this.db.run('INSERT INTO kb_events (tenant, seq, body, digest) VALUES (?, ?, ?, ?)', [
      this.tenantId,
      full.seq,
      JSON.stringify(full),
      full.digest,
    ]);
    return full;
  }

  async events(): Promise<readonly KnowledgeEvent[]> {
    const rows = await this.db.query<{ seq: number | string; body: string; digest: string }>(
      'SELECT seq, body, digest FROM kb_events WHERE tenant = ? ORDER BY seq',
      [this.tenantId],
    );
    const out: KnowledgeEvent[] = [];
    for (const row of rows) {
      const ev = JSON.parse(row.body) as KnowledgeEvent;
      const { digest, ...body } = ev;
      if (digestOf(body) !== digest || digest !== row.digest) throw new IntegrityError(`event ${row.seq} was altered`);
      if (ev.prevDigest !== (out[out.length - 1]?.digest ?? null) || ev.seq !== out.length + 1 || Number(row.seq) !== ev.seq)
        throw new IntegrityError(`the event log is broken at event ${row.seq}`);
      if (ev.tenantId !== this.tenantId) throw new IntegrityError(`event ${row.seq} belongs to another tenant`);
      out.push(ev);
    }
    return out;
  }

  async getHead(): Promise<HeadPointer | undefined> {
    const rows = await this.db.query<{ state_id: string; content_root: string; event_seq: number | string }>(
      'SELECT state_id, content_root, event_seq FROM kb_heads WHERE tenant = ?',
      [this.tenantId],
    );
    const r = rows[0];
    return r === undefined ? undefined : { stateId: r.state_id, contentRoot: r.content_root, eventSeq: Number(r.event_seq) };
  }

  async casHead(expected: string | null, next: HeadPointer): Promise<void> {
    if (this.tx.getStore() === undefined) throw new IntegrityError('the head moves only inside an exclusive transaction');
    if (expected === null)
      await this.db.run(
        'INSERT INTO kb_heads (tenant, state_id, content_root, event_seq) VALUES (?, ?, ?, ?) ON CONFLICT (tenant) DO NOTHING',
        [this.tenantId, next.stateId, next.contentRoot, next.eventSeq],
      );
    else
      await this.db.run('UPDATE kb_heads SET state_id = ?, content_root = ?, event_seq = ? WHERE tenant = ? AND state_id = ?', [
        next.stateId,
        next.contentRoot,
        next.eventSeq,
        this.tenantId,
        expected,
      ]);
    // States are immutable and chained, so the next state id is never the expected one: reading it back proves the swap.
    const now = await this.getHead();
    if (now?.stateId !== next.stateId || now.eventSeq !== next.eventSeq) throw new StaleHeadError(expected, now?.stateId ?? null);
  }

  async putIndex(stateId: string, index: unknown): Promise<void> {
    await this.putOnce('kb_indexes', stateId, index, 'index');
  }
  getIndex<T>(stateId: string): Promise<T | undefined> {
    return this.getOne<T>('kb_indexes', stateId, 'index');
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore() !== undefined) return fn(); // already inside this tenant's transaction
    return this.driver.transaction(`xo-kb:${this.tenantId}`, (tx) => this.tx.run(tx, fn));
  }

  async close(): Promise<void> {
    if (this.ownsDriver) await this.driver.close();
  }
}

/**
 * SQLite through Node's built-in `node:sqlite` (no native dependency). WAL journal, full synchronous commits, a busy timeout
 * so a second process waits for the lock instead of failing, and `BEGIN IMMEDIATE` so a writer takes the lock before reading
 * the head it is about to change. One connection per process: statements are serialised in-process.
 */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown };
  close(): void;
}

export async function sqliteDriver(path: string, options: { readonly busyTimeoutMs?: number } = {}): Promise<SqlDriver> {
  // `node:sqlite` is built into Node >= 22.5 (this repository requires >= 22.15). Loaded through Node's own `require`, by a
  // computed name: the type checker needs no declarations the pinned @types/node predates, and bundlers or test transformers
  // (which rewrite `node:` imports) never see it.
  const moduleName = 'node:sqlite';
  const { DatabaseSync } = createRequire(import.meta.url)(moduleName) as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new DatabaseSync(path);
  // busy_timeout 0: a synchronous busy-wait would block this process's event loop (and deadlock two connections in one process);
  // the write lock is instead acquired below by retrying `BEGIN IMMEDIATE` asynchronously until `busyTimeoutMs`.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
  const lockTimeoutMs = options.busyTimeoutMs ?? 30_000;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const exec = {
    query: <T extends Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): readonly T[] =>
      db.prepare(sql).all(...params) as unknown as T[],
    run: (sql: string, params: readonly SqlValue[] = []): void => {
      db.prepare(sql).run(...params);
    },
  };
  const inTx: SqlDriver = {
    dialect: 'sqlite',
    query: async (sql, params) => exec.query(sql, params),
    run: async (sql, params) => exec.run(sql, params),
    transaction: async (_k, fn) => fn(inTx),
    close: async () => undefined,
  };
  const driver: SqlDriver = {
    dialect: 'sqlite',
    query: (sql, params) => serial(() => exec.query(sql, params)),
    run: (sql, params) => serial(() => exec.run(sql, params)),
    transaction: (_lockKey, fn) =>
      serial(async () => {
        const deadline = Date.now() + lockTimeoutMs;
        for (;;) {
          try {
            db.exec('BEGIN IMMEDIATE');
            break;
          } catch (e) {
            const busy = /locked|busy/i.test((e as Error).message);
            if (!busy || Date.now() > deadline) throw e;
            await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
          }
        }
        try {
          const out = await fn(inTx);
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }),
    close: () =>
      serial(() => {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
      }),
  };
  return driver;
}

/** A consistent copy of a SQLite knowledge database while it is in use (`VACUUM INTO`), for live backups. */
export async function backupSqliteKnowledge(driver: SqlDriver, targetPath: string): Promise<void> {
  if (driver.dialect !== 'sqlite')
    throw new Error('backupSqliteKnowledge needs the SQLite driver; back up PostgreSQL with its own tooling');
  await driver.run('VACUUM INTO ?', [targetPath]);
}
