import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCliAudit } from '../src/commands/runtime/cli-audit.js';

// P1.0 M4 — CLI direct-runtime audit configuration semantics.

test('CLI audit: no config outside production is an explicit unaudited local run; production without config refuses to run', async () => {
  const dev = await openCliAudit({});
  assert.ok(dev.ok && dev.audit === undefined);
  const prod = await openCliAudit({ NODE_ENV: 'production' });
  assert.equal(prod.ok, false);
});

test('CLI audit: partial or invalid config refuses to run; full config yields a durable adapter that fails closed on audit outage', async () => {
  assert.equal((await openCliAudit({ XO_AUDIT_DIR: '/tmp/x' })).ok, false);
  assert.equal((await openCliAudit({ XO_AUDIT_DIR: '/tmp/x', XO_AUDIT_RETENTION_DAYS: '1', XO_AUDIT_MIN_RETENTION_DAYS: '2' })).ok, false);
  const dir = join(await mkdtemp(join(tmpdir(), 'xo-cli-audit-')), 'a');
  const good = await openCliAudit({ XO_AUDIT_DIR: dir, XO_AUDIT_RETENTION_DAYS: '30', XO_AUDIT_MIN_RETENTION_DAYS: '7' });
  assert.ok(good.ok && good.audit !== undefined);
  const subject = { kind: 'trusted-execution-context' } as never;
  if (good.ok && good.audit) {
    await good.audit.beforeExecute({ capabilityId: 'cap-1', requesterPackageId: 'p', subject });
    assert.equal(await good.audit.afterExecute({ capabilityId: 'cap-1', requesterPackageId: 'p', subject, ok: true }), true);
  }
  // unwritable location => the store cannot be opened => the command refuses
  const blocker = join(await mkdtemp(join(tmpdir(), 'xo-cli-audit-')), 'a-file');
  await writeFile(blocker, 'x');
  const bad = await openCliAudit({ XO_AUDIT_DIR: join(blocker, 'audit'), XO_AUDIT_RETENTION_DAYS: '30', XO_AUDIT_MIN_RETENTION_DAYS: '7' });
  assert.equal(bad.ok, false);
});
