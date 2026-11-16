/**
 * ADR 0031 — moving knowledge between stores, and restoring a SQLite backup, without trusting what is moved.
 *
 * `copyKnowledge` is the deployment transition from the file store to SQLite or PostgreSQL (and between any two stores):
 * every row is read through the source's integrity checks, written through the target's write-once checks, and the
 * hash-chained event log is replayed in order so the target's chain is digest-for-digest the source's. A target that
 * already holds knowledge for the tenant is refused: a migration never merges.
 *
 * `restoreSqliteKnowledge` verifies a backup completely (schema version, every tenant's rows against their digests and
 * every event chain) before it replaces the live database, and replaces it atomically.
 */
import { copyFile, rename, rm } from 'node:fs/promises';
import { IntegrityError, type KnowledgeStore } from './store.js';
import { KNOWLEDGE_SCHEMA_VERSION, SqlKnowledgeStore, sqliteDriver, type SqlDriver } from './sql-store.js';

export interface KnowledgeCopyReport {
  readonly tenantId: string;
  readonly records: number;
  readonly changeSets: number;
  readonly decisions: number;
  readonly states: number;
  readonly packs: number;
  readonly events: number;
  /** The digest of the last event: equal in source and target, or the copy throws. */
  readonly headEventDigest: string | null;
}

export class KnowledgeTransferError extends Error {
  override readonly name = 'KnowledgeTransferError';
}

/** True when the store holds nothing for its tenant (no events, states, change sets or records). */
export async function isKnowledgeStoreEmpty(store: KnowledgeStore): Promise<boolean> {
  return (
    (await store.events()).length === 0 &&
    (await store.listStates()).length === 0 &&
    (await store.listChangeSets()).length === 0 &&
    (await store.listRecords()).length === 0
  );
}

export async function copyKnowledge(from: KnowledgeStore, to: KnowledgeStore): Promise<KnowledgeCopyReport> {
  if (from.tenantId !== to.tenantId) throw new KnowledgeTransferError(`tenant mismatch: "${from.tenantId}" → "${to.tenantId}"`);
  return to.exclusive(async () => {
    if (!(await isKnowledgeStoreEmpty(to)))
      throw new KnowledgeTransferError(`the target already holds knowledge for tenant "${to.tenantId}"; a migration never merges`);
    // Reading verifies: every source row and the whole event chain are checked before anything is written.
    const events = await from.events();
    const packs = await from.listPacks();
    const records = await from.listRecords();
    const changeSets = await from.listChangeSets();
    const states = await from.listStates();
    for (const p of packs) await to.putPack(p);
    for (const r of records) await to.putRecord(r);
    let decisions = 0;
    for (const c of changeSets) {
      await to.putChangeSet(c);
      const d = await from.getDecision(c.changeSetId);
      if (d !== undefined) {
        await to.putDecision(d);
        decisions++;
      }
    }
    for (const s of states) await to.putState(s);
    for (const e of events) {
      const { seq, prevDigest, digest, tenantId, ...body } = e;
      void tenantId;
      const copied = await to.appendEvent(body);
      if (copied.seq !== seq || copied.prevDigest !== prevDigest || copied.digest !== digest)
        throw new KnowledgeTransferError(`event ${seq} did not reproduce in the target (digest ${copied.digest} ≠ ${digest})`);
    }
    return {
      tenantId: to.tenantId,
      records: records.length,
      changeSets: changeSets.length,
      decisions,
      states: states.length,
      packs: packs.length,
      events: events.length,
      headEventDigest: events[events.length - 1]?.digest ?? null,
    };
  });
}

/** The tenants a SQL knowledge database holds. */
export async function listKnowledgeTenants(driver: SqlDriver): Promise<readonly string[]> {
  const rows = await driver.query<{ tenant: string }>(
    'SELECT tenant FROM kb_events UNION SELECT tenant FROM kb_states UNION SELECT tenant FROM kb_change_sets UNION SELECT tenant FROM kb_records ORDER BY tenant',
  );
  return rows.map((r) => r.tenant);
}

export interface KnowledgeVerification {
  readonly schemaVersion: number;
  readonly tenants: readonly KnowledgeCopyReport[];
}

/** Reads every row and every event chain of a SQL knowledge database through the integrity checks. Throws on the first fault. */
export async function verifySqlKnowledge(driver: SqlDriver): Promise<KnowledgeVerification> {
  const v = await driver.query<{ version: number | string }>('SELECT version FROM kb_schema').catch(() => {
    throw new IntegrityError('not a knowledge database (no kb_schema table)');
  });
  const schemaVersion = v.length === 1 ? Number(v[0]!.version) : NaN;
  if (schemaVersion !== KNOWLEDGE_SCHEMA_VERSION)
    throw new IntegrityError(`knowledge schema ${String(v[0]?.version)} is not the schema this build reads (${KNOWLEDGE_SCHEMA_VERSION})`);
  const tenants: KnowledgeCopyReport[] = [];
  for (const tenantId of await listKnowledgeTenants(driver)) {
    const store = await SqlKnowledgeStore.open(driver, tenantId);
    const events = await store.events();
    const changeSets = await store.listChangeSets();
    let decisions = 0;
    for (const c of changeSets) if ((await store.getDecision(c.changeSetId)) !== undefined) decisions++;
    tenants.push({
      tenantId,
      records: (await store.listRecords()).length,
      changeSets: changeSets.length,
      decisions,
      states: (await store.listStates()).length,
      packs: (await store.listPacks()).length,
      events: events.length,
      headEventDigest: events[events.length - 1]?.digest ?? null,
    });
  }
  return { schemaVersion, tenants };
}

/**
 * Replaces the SQLite knowledge database at `targetPath` with the backup at `backupPath`, after verifying the backup
 * completely. The instance must be stopped (nothing may hold the target open). The live file is replaced atomically and
 * its WAL and shared-memory files are removed, so no page from the old database survives into the restored one.
 */
export async function restoreSqliteKnowledge(backupPath: string, targetPath: string): Promise<KnowledgeVerification> {
  const staging = `${targetPath}.restore-${process.pid}-${Date.now()}`;
  await copyFile(backupPath, staging);
  let verification: KnowledgeVerification;
  const driver = await sqliteDriver(staging);
  try {
    verification = await verifySqlKnowledge(driver);
  } catch (cause) {
    await driver.close();
    await rm(staging, { force: true });
    throw cause;
  }
  await driver.close();
  for (const suffix of ['-wal', '-shm']) {
    await rm(`${staging}${suffix}`, { force: true });
    await rm(`${targetPath}${suffix}`, { force: true });
  }
  await rename(staging, targetPath);
  return verification;
}
