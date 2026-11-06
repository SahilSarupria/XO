import type { DbDriver, SqlValue } from './database.js';
import { ConnectorError } from './types.js';

/**
 * A real driver over Node's built-in SQLite (`node:sqlite`, experimental), opened READ-ONLY AT THE ENGINE LEVEL with `query_only` on as well: a
 * statement that somehow reached it still could not write. Loaded lazily, so importing this package never triggers the experimental warning and
 * Node versions without the module simply cannot build this driver (they get a clear error).
 *
 * Limits: SQLite's API here is synchronous, so a long-running query cannot be interrupted by the abort signal. Use this driver for local files and
 * small data; put a networked database behind a driver that supports cancellation.
 */
interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { iterate(...values: SqlValue[]): Iterable<unknown> };
  };
}

export async function sqliteReadOnlyDriver(path: string): Promise<DbDriver> {
  let mod: SqliteModule;
  try {
    const specifier = 'node:sqlite'; // non-literal: type definitions for this experimental module are not always installed
    mod = (await import(specifier)) as SqliteModule;
  } catch {
    throw new ConnectorError('FAILED', 'this Node.js has no node:sqlite; use another driver');
  }
  const db = new mod.DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return {
    query: async (sql, values: readonly SqlValue[], opts) => {
      const stmt = db.prepare(sql);
      const rows: Record<string, unknown>[] = [];
      let n = 0;
      for (const r of stmt.iterate(...values)) {
        if (++n > opts.maxRows) break; // stop reading as soon as the limit is exceeded
        rows.push({ ...(r as Record<string, unknown>) });
      }
      return { rows };
    },
  };
}
