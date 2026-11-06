import { ConnectorError, type Connector, type Json, type OperationContext } from './types.js';

/**
 * Read-only database access for workflows, by allowlisted prepared statements only.
 *
 * A workflow never sends SQL. It names a statement the OPERATOR declared and supplies values for that statement's declared, typed parameters.
 * Values are bound positionally by the driver and are never concatenated into SQL, so there is no string a workflow can send that becomes SQL.
 *
 * Defence in depth (none of it replaces a database role that can only SELECT, which is the real boundary and which only the operator can create):
 *  - every statement is checked when the connector is built: one statement, starts with SELECT/WITH, no write/DDL/session/file keywords, no
 *    comments or string literals able to hide one, placeholders match the declared parameters. A statement that fails stops the process from starting;
 *  - the driver contract is "read-only transaction"; the bundled SQLite driver opens the file read-only at the engine level;
 *  - row count, result size and run time are bounded; overflow is refused by default rather than silently truncated.
 * Write operations do not exist in IR 1.0, and the validator already refuses a `database` declaration with a write side effect.
 */

export type SqlValue = string | number | boolean | null;

export interface DbDriver {
  /** Must run `sql` in a read-only context with `values` bound positionally, return at most `maxRows` rows, and stop when `signal` aborts. */
  query(
    sql: string,
    values: readonly SqlValue[],
    opts: { readonly maxRows: number; readonly signal: AbortSignal },
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
}

export interface ParamDef {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'number' | 'boolean';
  readonly nullable?: boolean;
}

export interface StatementDef {
  readonly sql: string;
  readonly params: readonly ParamDef[];
  /** Per-statement ceiling, never above the connector's. */
  readonly maxRows?: number;
}

export interface DatabaseConfig {
  readonly statements: Readonly<Record<string, StatementDef>>;
  readonly driver: DbDriver;
  readonly maxRows?: number;
  readonly maxResultBytes?: number;
  /** `refuse` (default): a result over the row limit is an error. `truncate`: return the first rows and say so. */
  readonly onOverflow?: 'refuse' | 'truncate';
}

const STATEMENT_ID = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_STRING = 4096;

/** Words that make a statement more than a read: writes, DDL, transaction/session control, file and extension access, locks, sleeps. */
const FORBIDDEN = new Set(
  (
    'insert update delete drop alter create truncate grant revoke copy call exec execute merge replace upsert attach detach pragma vacuum reindex analyze ' +
    'into set reset lock unlock begin commit rollback savepoint release load import export use handler do prepare deallocate listen notify refresh cluster ' +
    'pg_sleep sleep benchmark load_extension readfile writefile lo_import lo_export dblink pg_read_file pg_read_binary_file pg_ls_dir pg_terminate_backend pg_cancel_backend'
  ).split(' '),
);

interface Scan {
  readonly skeleton: string;
  readonly problem?: string;
}

/** Removes comments and string/identifier literals (leaving a placeholder) so keyword checks run on code only. Refuses anything it cannot tokenize with certainty. */
function skeletonOf(sql: string): Scan {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      const e = sql.indexOf('\n', i);
      i = e === -1 ? sql.length : e + 1;
      out += ' ';
    } else if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (e === -1) return { skeleton: out, problem: 'unterminated comment' };
      i = e + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return { skeleton: out, problem: 'unterminated quoted text' };
        if (sql[j] === '\\') return { skeleton: out, problem: 'backslash inside quoted text (its meaning differs between databases)' };
        if (sql[j] === c) {
          if (sql[j + 1] === c)
            j += 2; // doubled quote
          else break;
        } else j++;
      }
      i = j + 1;
      out += c === "'" ? ' _text_ ' : ' _id_ '; // markers cannot collide with placeholders (`?`, `$n`) or with a forbidden word
    } else if (c === '$' && /[A-Za-z_$]/.test(n ?? '')) {
      return { skeleton: out, problem: 'dollar-quoted text is not supported' };
    } else if (c === '[') {
      return { skeleton: out, problem: 'bracket-quoted identifiers are not supported' };
    } else {
      out += c;
      i++;
    }
  }
  return { skeleton: out };
}

/** Returns why a statement is not a safe single read, or undefined. Exported so operators and tests can vet a statement without building a connector. */
export function readOnlySqlProblem(sql: string, paramCount: number): string | undefined {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 8192)
    return 'sql must be a non-empty string of at most 8192 characters';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql)) return 'sql contains control characters';
  const { skeleton, problem } = skeletonOf(sql);
  if (problem !== undefined) return problem;
  const body = skeleton.trim().replace(/;\s*$/, '');
  if (body.includes(';')) return 'more than one statement';
  const words = body.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  if (words[0] !== 'select' && words[0] !== 'with') return 'must start with SELECT or WITH';
  const bad = words.find((w) => FORBIDDEN.has(w));
  if (bad !== undefined) return `contains "${bad}", which is not allowed in a read-only statement`;
  const q = body.match(/\?/g)?.length ?? 0;
  const dollars = [...body.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  if (q > 0 && dollars.length > 0) return 'mixes ? and $n placeholders';
  if (dollars.length > 0) {
    const distinct = [...new Set(dollars)].sort((a, b) => a - b);
    if (distinct.length !== paramCount || distinct.some((d, i) => d !== i + 1)) return `$n placeholders must be exactly $1..$${paramCount}`;
  } else if (q !== paramCount) return `${q} placeholder(s) for ${paramCount} declared parameter(s)`;
  return undefined;
}

function paramProblem(def: ParamDef, v: Json | undefined): string | undefined {
  if (v === undefined) return 'missing';
  if (v === null) return def.nullable === true ? undefined : 'null is not allowed';
  switch (def.type) {
    case 'string':
      return typeof v === 'string' && v.length <= MAX_STRING && !v.includes('\u0000')
        ? undefined
        : `expected a string of at most ${MAX_STRING} characters without NUL`;
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v) ? undefined : 'expected a safe integer';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : 'expected a finite number';
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'expected a boolean';
  }
}

/** Operation `query` (read): `{ statement: <id>, params?: { <name>: value } }`. Result: `{ rows, rowCount, truncated }`. */
export function databaseConnector(cfg: DatabaseConfig): Connector {
  const hardMax = cfg.maxRows ?? 1000;
  if (!Number.isInteger(hardMax) || hardMax < 1 || hardMax > 100_000)
    throw new Error('database: maxRows must be an integer in [1, 100000]');
  const maxBytes = cfg.maxResultBytes ?? 1_048_576;
  const ids = Object.keys(cfg.statements);
  if (ids.length === 0) throw new Error('database: at least one statement must be declared');
  for (const id of ids) {
    if (!STATEMENT_ID.test(id)) throw new Error(`database: statement id "${id}" must match ${STATEMENT_ID}`);
    const s = cfg.statements[id]!;
    const names = s.params.map((p) => p.name);
    if (new Set(names).size !== names.length || names.some((n) => !PARAM_NAME.test(n)))
      throw new Error(`database: statement "${id}" has invalid or duplicate parameter names`);
    const p = readOnlySqlProblem(s.sql, s.params.length);
    if (p !== undefined) throw new Error(`database: statement "${id}" refused: ${p}`);
    if (s.maxRows !== undefined && (!Number.isInteger(s.maxRows) || s.maxRows < 1))
      throw new Error(`database: statement "${id}" maxRows must be a positive integer`);
  }

  return {
    kind: 'database',
    operations: {
      query: {
        sideEffect: 'read',
        execute: async (args: Readonly<Record<string, Json>>, ctx: OperationContext): Promise<Json> => {
          const extra = Object.keys(args).filter((k) => k !== 'statement' && k !== 'params');
          if (extra.length > 0) throw new ConnectorError('DENIED', `unknown argument(s): ${extra.join(', ')} (a workflow cannot send SQL)`);
          const id = args['statement'];
          if (typeof id !== 'string' || !Object.hasOwn(cfg.statements, id)) throw new ConnectorError('DENIED', 'unknown statement');
          const def = cfg.statements[id]!;
          const given = args['params'] ?? {};
          if (typeof given !== 'object' || given === null || Array.isArray(given))
            throw new ConnectorError('DENIED', 'args.params must be an object');
          const declared = new Set(def.params.map((p) => p.name));
          const stray = Object.keys(given).filter((k) => !declared.has(k));
          if (stray.length > 0) throw new ConnectorError('DENIED', `unknown parameter(s): ${stray.join(', ')}`);
          const values: SqlValue[] = [];
          for (const p of def.params) {
            const v = (given as Record<string, Json>)[p.name];
            const why = paramProblem(p, v);
            if (why !== undefined) throw new ConnectorError('DENIED', `parameter "${p.name}": ${why}`);
            values.push(v as SqlValue);
          }
          const limit = Math.min(def.maxRows ?? hardMax, hardMax);
          ctx.signal.throwIfAborted();
          const raced = new Promise<never>((_, reject) =>
            ctx.signal.addEventListener('abort', () => reject(new ConnectorError('TIMEOUT', 'query aborted')), { once: true }),
          );
          raced.catch(() => undefined);
          const res = await Promise.race([
            cfg.driver.query(def.sql, values, { maxRows: limit + 1, signal: ctx.signal }).catch((e: unknown) => {
              // a driver message can hold connection strings, SQL text or the bound VALUES (personal data): only a coarse class leaves this function
              if (e instanceof ConnectorError) throw e;
              const code = (e as { code?: unknown } | null)?.code;
              throw new ConnectorError(
                'FAILED',
                `database query failed${typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? ` (${code})` : ''}`,
              );
            }),
            raced,
          ]);
          let rows = res.rows;
          let truncated = false;
          if (rows.length > limit) {
            if (cfg.onOverflow === 'truncate') {
              rows = rows.slice(0, limit);
              truncated = true;
            } else throw new ConnectorError('DENIED', `result has more than ${limit} rows; refusing to return a partial answer`);
          }
          const out: Json[] = [];
          for (const r of rows) {
            const row: Record<string, Json> = {};
            for (const [k, v] of Object.entries(r)) {
              if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
                throw new ConnectorError('DENIED', `column "${k}" has a type that cannot be returned (convert it in the statement)`);
              row[k] = v as Json;
            }
            out.push(row);
          }
          const result = { rows: out, rowCount: out.length, truncated };
          if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new ConnectorError('DENIED', `result exceeds ${maxBytes} bytes`);
          return result;
        },
      },
    },
  };
}
