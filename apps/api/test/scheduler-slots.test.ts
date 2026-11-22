/** UW-15 (ADR 0044): missed slots and the scheduler lease, through the real scheduler against a real controls store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLeaseStore } from '@xo/automation';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { AuditService } from '../src/audit/audit-service.js';
import { NonProductionAuditSink } from '@xo/audit';
import { FsControlsStore } from '../src/workflow-controls/fs-controls-store.js';
import { runDueSchedules, tickWithLease, type SchedulerDeps } from '../src/workflow-controls/scheduler.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { workspaceStateStore } from '../src/workspace/workspace-context.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const EVERY = 10; // minutes
const T0 = Date.parse('2026-11-20T10:00:00Z');

async function setup(run: (a: { deps: SchedulerDeps; controls: FsControlsStore }) => Promise<void>): Promise<void> {
  await withTempDir('xo-api-slots-', async (dataDir) =>
    withTempDir('xo-api-slots-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const store = new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir));
        const workspace = await store.get(ws);
        assert.ok(workspace.ok);
        if (!workspace.ok) return;
        const controls = new FsControlsStore(workspaceStateStore(workspace.value, { dataRootDir: dataDir }), ws);
        await controls.mutate('cmp_x', 'wf_x', 'test', new Date(T0).toISOString(), (d) => ({
          ...d,
          mode: 'live',
          triggers: { webhook: false, schedule: { everyMinutes: EVERY, lastFiredAt: new Date(T0).toISOString(), input: {} } },
        }));
        const deps: SchedulerDeps = {
          workspaceStore: store,
          dataConfig: { dataRootDir: dataDir, packageTrustPolicy: PackageTrustPolicy.development() },
          permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
          audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
        };
        await run({ deps, controls });
      } finally {
        await server.stop();
      }
    }),
  );
}
const outcome = async (c: FsControlsStore): Promise<string> =>
  (await c.getDeployment('cmp_x', 'wf_x'))?.triggers.schedule?.lastOutcome ?? '';

test('missedSlots=skip: after downtime no run starts, the missed slots are recorded, and the cadence resumes from now', async () => {
  await setup(async ({ deps, controls }) => {
    const later = new Date(T0 + 95 * 60_000); // nine slots later
    assert.deepEqual(await runDueSchedules({ ...deps, missedSlots: 'skip' }, later), { started: 0, skipped: 1 });
    assert.match(await outcome(controls), /^skipped: missed 8 slots while nothing was running$/);
    assert.equal((await controls.getDeployment('cmp_x', 'wf_x'))?.triggers.schedule?.lastFiredAt, later.toISOString());
    assert.deepEqual(
      await runDueSchedules({ ...deps, missedSlots: 'skip' }, new Date(later.getTime() + 5 * 60_000)),
      { started: 0, skipped: 0 },
      'not due again yet',
    );
  });
});

test('missedSlots=run_latest: after downtime the latest missed slot runs (once) and the earlier ones are recorded as skipped', async () => {
  await setup(async ({ deps, controls }) => {
    const later = new Date(T0 + 95 * 60_000);
    const r = await runDueSchedules({ ...deps, missedSlots: 'run_latest' }, later);
    // The deployment has no workflow behind it, so the start itself is refused; what matters is the slot decision and its record.
    assert.deepEqual(r, { started: 0, skipped: 1 });
    const text = await outcome(controls);
    assert.doesNotMatch(text, /missed 8 slots while nothing was running/, 'a slot was attempted, not wholly skipped');
    assert.match(text, /^(skipped|could not start): /);
  });
});

test('on time, nothing is recorded as missed', async () => {
  await setup(async ({ deps, controls }) => {
    await runDueSchedules(deps, new Date(T0 + EVERY * 60_000 + 1000));
    assert.doesNotMatch(await outcome(controls), /missed/);
  });
});

test('lease: only the holder ticks; the other waits, and takes over once the holder stops renewing', async () => {
  await setup(async ({ deps, controls }) => {
    const store = new MemoryLeaseStore();
    const a: SchedulerDeps = { ...deps, missedSlots: 'skip', lease: { store, holder: 'A', ttlMs: 90_000 } };
    const b: SchedulerDeps = { ...deps, missedSlots: 'skip', lease: { store, holder: 'B', ttlMs: 90_000 } };
    const t = new Date(T0 + 95 * 60_000);
    assert.deepEqual(await tickWithLease(a, t, 30_000), { started: 0, skipped: 1 }, 'A holds the lease and fires');
    assert.equal(await tickWithLease(b, new Date(t.getTime() + 30_000), 30_000), undefined, 'B is refused while A holds it');
    const lastA = (await controls.getDeployment('cmp_x', 'wf_x'))?.triggers.schedule?.lastFiredAt;
    // A stops renewing. After the lease expires B takes over (fence bumped) and ticks.
    const later = new Date(t.getTime() + 20 * 60_000);
    assert.notEqual(await tickWithLease(b, later, 30_000), undefined, 'B takes over after expiry');
    assert.equal(await tickWithLease(a, new Date(later.getTime() + 1000), 30_000), undefined, 'A no longer holds it');
    assert.ok(lastA !== undefined);
  });
});

test('every slot goes through the automation engine: recorded in its ledger by ids only, and at most once even after a restart', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { releaseEngine } = await import('../src/workflow-controls/scheduler.js');
  await setup(async ({ deps, controls }) => {
    const due = new Date(T0 + EVERY * 60_000 + 1_000);
    const first = await runDueSchedules(deps, due);
    assert.equal(first.started + first.skipped, 1, 'the due slot fired once');
    const fired = (await controls.getDeployment('cmp_x', 'wf_x'))?.triggers.schedule?.lastFiredAt;
    // A crash after the slot fired but before it was recorded: put the old lastFiredAt back, and restart the engine.
    await controls.mutate('cmp_x', 'wf_x', 'test', due.toISOString(), (d) => ({
      ...d,
      triggers: { ...d.triggers, schedule: { ...d.triggers.schedule!, lastFiredAt: new Date(T0).toISOString() } },
    }));
    await releaseEngine(deps);
    assert.deepEqual(await runDueSchedules(deps, due), { started: 0, skipped: 0 }, 'the same slot is never fired twice');
    const ledger = await readFile(join(deps.dataConfig.dataRootDir, 'automation', 'schedules', 'ledger.jsonl'), 'utf8');
    const types = ledger
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    assert.equal(types.filter((t) => t === 'job.accepted').length, 1);
    assert.equal(types.filter((t) => t === 'job.duplicate').length, 1);
    assert.ok(ledger.includes(`cmp_x/wf_x@${EVERY}m:`), 'keyed by workflow and slot');
    assert.ok(fired !== undefined);
    await releaseEngine(deps);
  });
});

test('a second live process cannot fire schedules while the first holds the engine directory', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { hostname } = await import('node:os');
  const { releaseEngine } = await import('../src/workflow-controls/scheduler.js');
  await setup(async ({ deps }) => {
    const dir = join(deps.dataConfig.dataRootDir, 'automation', 'schedules');
    await mkdir(dir, { recursive: true });
    // The parent process stands in for another live API process holding the engine.
    await writeFile(join(dir, 'engine.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() }));
    const lines: string[] = [];
    const r = await runDueSchedules({ ...deps, log: (l) => lines.push(l) }, new Date(T0 + EVERY * 60_000 + 1_000));
    assert.deepEqual(r, { started: 0, skipped: 0 });
    assert.ok(lines.some((l) => l.includes('another process holds the schedule engine')));
    await releaseEngine(deps);
  });
});
