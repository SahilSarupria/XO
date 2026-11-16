/**
 * PostgreSQL for the Business Knowledge Base (ADR 0030). One database holds every tenant; rows are keyed by tenant. A write
 * transaction takes `pg_advisory_xact_lock` on the tenant, so propose/approve/reject are serialised across every API
 * process and machine, and the lock is released by commit or rollback (a crashed writer can never hold it).
 *
 *   const pool = new pg.Pool({ connectionString: process.env.XO_KNOWLEDGE_DATABASE_URL });
 *   const store = await SqlKnowledgeStore.open(postgresDriver(pool), workspaceId);
 *
 * Backups, point-in-time recovery and replication are PostgreSQL's (pg_dump / base backups + WAL archiving); XO adds none.
 */
import pg from 'pg';
import type { SqlDriver, SqlValue } from '@xo/knowledge-base';

/** `?` placeholders → `$1, $2, …` (the store's SQL never contains a literal `?`). */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

function on(client: pg.Pool | pg.PoolClient): Pick<SqlDriver, 'query' | 'run'> {
  return {
    query: async <T extends Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []) =>
      (await client.query(numbered(sql), [...params])).rows as T[],
    run: async (sql: string, params: readonly SqlValue[] = []) => {
      await client.query(numbered(sql), [...params]);
    },
  };
}

export function postgresDriver(pool: pg.Pool, options: { readonly ownsPool?: boolean } = {}): SqlDriver {
  const driver: SqlDriver = {
    dialect: 'postgres',
    ...on(pool),
    transaction: async (lockKey, fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
        const tx: SqlDriver = {
          dialect: 'postgres',
          ...on(client),
          transaction: async (_k, inner) => inner(tx),
          close: async () => undefined,
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: async () => {
      if (options.ownsPool === true) await pool.end();
    },
  };
  return driver;
}

export { pg };
