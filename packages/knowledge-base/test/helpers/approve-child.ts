/**
 * A separate process that approves one change set (UW-4b crash and concurrency tests). Run with `node --import tsx`.
 *
 *   approve-child.ts <db> <tenant> <changeSetId> [killAtStatement]
 *
 * With `killAtStatement` = k, the process SIGKILLs itself just before issuing the k-th SQL statement of the approval's
 * transaction: a power cut at that exact point, with no chance to roll back, flush or clean up. With k = 0 it runs to the end
 * and prints how many statements the approval issued. It prints one JSON line: {ok, stateId} or {ok:false, code, message}.
 */
import { KnowledgeBase, SqlKnowledgeStore, sqliteDriver, type SqlDriver } from '../../src/index.js';

const [db, tenant, changeSetId, killAtArg] = process.argv.slice(2) as [string, string, string, string | undefined];
const killAt = Number(killAtArg ?? 0);
const real = await sqliteDriver(db, { busyTimeoutMs: 20_000 });
let armed = false;
let count = 0;
const tick = (): void => {
  if (!armed) return;
  count++;
  if (killAt > 0 && count === killAt) process.kill(process.pid, 'SIGKILL');
};
const wrap = (d: SqlDriver): SqlDriver => ({
  dialect: d.dialect,
  query: (sql, params) => (tick(), d.query(sql, params)),
  run: (sql, params) => (tick(), d.run(sql, params)),
  transaction: (key, fn) => d.transaction(key, (tx) => fn(wrap(tx))),
  close: () => d.close(),
});
const store = await SqlKnowledgeStore.open(wrap(real), tenant);
const kb = new KnowledgeBase(store);
armed = true;
try {
  const s = await kb.approve(changeSetId, { id: 'u-reviewer', kind: 'user' }, 'child');
  armed = false;
  process.stdout.write(`${JSON.stringify({ ok: true, stateId: s.stateId, statements: count })}\n`);
} catch (e) {
  armed = false;
  process.stdout.write(`${JSON.stringify({ ok: false, code: (e as { code?: string }).code, message: (e as Error).message })}\n`);
}
await real.close();
