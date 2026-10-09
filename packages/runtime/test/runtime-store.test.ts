import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntimeStore } from '../src/persistence/in-memory-runtime-store.js';
import { FileRuntimeStore } from '../src/persistence/file/file-runtime-store.js';
import { atomicWriteJson } from '../src/persistence/file/atomic-file-io.js';
import type { RuntimeStore } from '../src/persistence/runtime-store.interface.js';
import { CURRENT_RUNTIME_STORE_VERSION } from '../src/persistence/versioning.js';
import { NodeId, type WorkflowGraph } from '../src/workflow/workflow-graph.js';
import { createInitialState } from '../src/workflow/workflow-state.js';
import { createCheckpoint } from '../src/workflow/workflow-checkpoint.js';
import { buildWorkflowReceipt } from '../src/workflow/workflow-receipt.js';
import type { ExecutionSession } from '../src/session/execution-session.js';
import type { ExecutionReceipt } from '../src/session/execution-receipt.js';
import { SessionId, RequestId, WorkflowInstanceId } from '../src/ids.js';
import type { WorkflowInstance } from '../src/workflow/workflow-instance.js';

const now = () => new Date('2026-01-01T00:00:00.000Z');

function fixtureSession(id = 's1'): ExecutionSession {
  return { sessionId: SessionId(id), requestId: RequestId('r1'), mountedPackages: [], chosenCapabilities: [], status: 'completed', receipts: [], createdAt: 't', updatedAt: 't' };
}

function fixtureGraph(id = 'g1'): WorkflowGraph {
  return { graphId: id, version: '1.0.0', startNodeId: NodeId('a'), nodes: [{ id: NodeId('a'), type: 'start' }], edges: [] };
}

function fixtureInstance(id = 'wf1'): WorkflowInstance {
  return Object.freeze({
    workflowInstanceId: WorkflowInstanceId(id),
    graph: fixtureGraph(),
    state: { ...createInitialState(now), completedNodes: [NodeId('a')] },
    status: 'completed' as const,
    createdAt: 't',
    updatedAt: 't',
  });
}

function fixtureExecutionReceipt(id = 'er1'): ExecutionReceipt {
  return {
    receiptId: id as never,
    requestId: RequestId('r1'),
    planId: 'p1' as never,
    packagesUsed: [],
    componentHashes: [],
    capabilitiesInvoked: [],
    executionDurationMs: 1,
    tokenUsage: { promptTokens: 1, completionTokens: 1 },
    validationResults: { valid: true, issues: [] },
    errors: [],
    createdAt: 't',
  };
}

interface StoreFixture {
  readonly name: string;
  readonly create: () => Promise<{ readonly store: RuntimeStore; readonly cleanup: () => Promise<void> }>;
}

const fixtures: readonly StoreFixture[] = [
  { name: 'InMemoryRuntimeStore', create: async () => ({ store: new InMemoryRuntimeStore(now), cleanup: async () => {} }) },
  {
    name: 'FileRuntimeStore',
    create: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-'));
      return { store: new FileRuntimeStore({ rootDir: dir, now }), cleanup: async () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

for (const fixture of fixtures) {
  test(`[${fixture.name}] session create/get/update/list/delete`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const session = fixtureSession('s1');
      await store.sessions.create(session);

      const got = await store.sessions.get(SessionId('s1'));
      assert.ok(got.ok && got.value);
      assert.equal(got.value?.data.sessionId, 's1');
      assert.equal(got.value?.version, CURRENT_RUNTIME_STORE_VERSION);

      const updated = { ...session, status: 'failed' as const };
      await store.sessions.update(updated);
      const gotAfterUpdate = await store.sessions.get(SessionId('s1'));
      assert.equal(gotAfterUpdate.ok && gotAfterUpdate.value?.data.status, 'failed');

      const listed = await store.sessions.list();
      assert.equal(listed.ok && listed.value.length, 1);

      const deleted = await store.sessions.delete(SessionId('s1'));
      assert.equal(deleted.ok && deleted.value, true);
      const gotAfterDelete = await store.sessions.get(SessionId('s1'));
      assert.equal(gotAfterDelete.ok && gotAfterDelete.value, undefined);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] session get() on an unknown id returns ok(undefined), not an error`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const result = await store.sessions.get(SessionId('never-created'));
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.value, undefined);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] execution save/get/list/delete`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const instance = fixtureInstance('wf1');
      await store.executions.save({ executionId: instance.workflowInstanceId, instance, waitingNodeIds: [] });

      const got = await store.executions.get(WorkflowInstanceId('wf1'));
      assert.ok(got.ok && got.value);
      assert.equal(got.value?.data.instance.status, 'completed');
      assert.deepEqual(got.value?.data.instance.state.completedNodes, [NodeId('a')]);

      const listed = await store.executions.list();
      assert.equal(listed.ok && listed.value.length, 1);

      const deleted = await store.executions.delete(WorkflowInstanceId('wf1'));
      assert.equal(deleted.ok && deleted.value, true);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] checkpoints are assigned increasing sequence numbers and listed in order`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const instance = fixtureInstance('wf-cp');
      const cp1 = createCheckpoint(instance, now);
      const cp2 = createCheckpoint({ ...instance, updatedAt: 'later' }, now);
      const cp3 = createCheckpoint({ ...instance, updatedAt: 'even later' }, now);

      const saved1 = await store.checkpoints.save(cp1);
      const saved2 = await store.checkpoints.save(cp2);
      const saved3 = await store.checkpoints.save(cp3);
      assert.ok(saved1.ok && saved2.ok && saved3.ok);
      if (saved1.ok && saved2.ok && saved3.ok) {
        assert.equal(saved1.value.data.sequence, 0);
        assert.equal(saved2.value.data.sequence, 1);
        assert.equal(saved3.value.data.sequence, 2);
      }

      const listed = await store.checkpoints.listForExecution(WorkflowInstanceId('wf-cp'));
      assert.ok(listed.ok);
      if (listed.ok) {
        assert.equal(listed.value.length, 3);
        assert.deepEqual(listed.value.map((r) => r.data.sequence), [0, 1, 2]);
      }

      const latest = await store.checkpoints.latestForExecution(WorkflowInstanceId('wf-cp'));
      assert.ok(latest.ok && latest.value);
      assert.equal(latest.value?.data.checkpointId, cp3.checkpointId);

      const gotById = await store.checkpoints.get(cp2.checkpointId);
      assert.ok(gotById.ok && gotById.value);
      assert.equal(gotById.value?.data.sequence, 1);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] latestForExecution returns undefined (not an error) when no checkpoint exists`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const result = await store.checkpoints.latestForExecution(WorkflowInstanceId('never-checkpointed'));
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.value, undefined);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] checkpoint delete removes it from both get() and listForExecution()`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const instance = fixtureInstance('wf-cp-del');
      const cp = createCheckpoint(instance, now);
      await store.checkpoints.save(cp);
      const deleted = await store.checkpoints.delete(cp.checkpointId);
      assert.equal(deleted.ok && deleted.value, true);
      const got = await store.checkpoints.get(cp.checkpointId);
      assert.equal(got.ok && got.value, undefined);
      const listed = await store.checkpoints.listForExecution(WorkflowInstanceId('wf-cp-del'));
      assert.equal(listed.ok && listed.value.length, 0);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] receipts: both execution and workflow receipts persist and are retrievable`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const instance = fixtureInstance('wf-receipts');
      const executionReceipt = fixtureExecutionReceipt('er1');
      await store.receipts.saveExecutionReceipt(instance.workflowInstanceId, executionReceipt);

      const workflowReceipt = buildWorkflowReceipt({ instance, nodeReceipts: [{ nodeId: NodeId('a'), receipt: executionReceipt }], durationMs: 5, now });
      await store.receipts.saveWorkflowReceipt(workflowReceipt);

      const gotExecution = await store.receipts.getExecutionReceipt('er1' as never);
      assert.ok(gotExecution.ok && gotExecution.value);
      assert.equal(gotExecution.value?.data.receiptId, 'er1');

      const gotWorkflow = await store.receipts.getWorkflowReceipt(workflowReceipt.receiptId);
      assert.ok(gotWorkflow.ok && gotWorkflow.value);
      assert.equal(gotWorkflow.value?.data.workflowInstanceId, 'wf-receipts');

      const byExecution = await store.receipts.listByExecution(instance.workflowInstanceId);
      assert.ok(byExecution.ok);
      if (byExecution.ok) {
        assert.equal(byExecution.value.length, 2);
        assert.ok(byExecution.value.some((r) => r.data.kind === 'execution'));
        assert.ok(byExecution.value.some((r) => r.data.kind === 'workflow'));
      }
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] receipts are immutable once saved: re-fetching returns the same content`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const receipt = fixtureExecutionReceipt('er-immutable');
      await store.receipts.saveExecutionReceipt(undefined, receipt);
      const first = await store.receipts.getExecutionReceipt('er-immutable' as never);
      const second = await store.receipts.getExecutionReceipt('er-immutable' as never);
      assert.deepEqual(first, second);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] concurrent writes to the same session id all succeed`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const base = fixtureSession('concurrent');
      await Promise.all([
        store.sessions.create(base),
        store.sessions.update({ ...base, status: 'failed' }),
        store.sessions.update({ ...base, status: 'completed' }),
      ]);
      const got = await store.sessions.get(SessionId('concurrent'));
      assert.ok(got.ok && got.value);
      assert.ok(['pending', 'failed', 'completed'].includes(got.value?.data.status ?? ''));
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] concurrent checkpoint writes for the same execution all get distinct sequence numbers`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const instance = fixtureInstance('wf-concurrent-cp');
      const checkpoints = [createCheckpoint(instance, now), createCheckpoint(instance, now), createCheckpoint(instance, now)];
      await Promise.all(checkpoints.map((cp) => store.checkpoints.save(cp)));
      const listed = await store.checkpoints.listForExecution(WorkflowInstanceId('wf-concurrent-cp'));
      assert.ok(listed.ok);
      if (listed.ok) {
        const sequences = listed.value.map((r) => r.data.sequence).sort((a, b) => a - b);
        assert.deepEqual(sequences, [0, 1, 2]);
      }
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] concurrent receipt writes for different executions do not interfere`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      await Promise.all([
        store.receipts.saveExecutionReceipt(WorkflowInstanceId('exec-a'), fixtureExecutionReceipt('era')),
        store.receipts.saveExecutionReceipt(WorkflowInstanceId('exec-b'), fixtureExecutionReceipt('erb')),
      ]);
      const a = await store.receipts.listByExecution(WorkflowInstanceId('exec-a'));
      const b = await store.receipts.listByExecution(WorkflowInstanceId('exec-b'));
      assert.equal(a.ok && a.value.length, 1);
      assert.equal(b.ok && b.value.length, 1);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] two concurrent reads of the same record both succeed`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      await store.sessions.create(fixtureSession('read-both'));
      const [a, b] = await Promise.all([store.sessions.get(SessionId('read-both')), store.sessions.get(SessionId('read-both'))]);
      assert.ok(a.ok && a.value && b.ok && b.value);
    } finally {
      await cleanup();
    }
  });

  test(`[${fixture.name}] multiple independent sessions can be created and listed together`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      await Promise.all([store.sessions.create(fixtureSession('m1')), store.sessions.create(fixtureSession('m2')), store.sessions.create(fixtureSession('m3'))]);
      const listed = await store.sessions.list();
      assert.equal(listed.ok && listed.value.length, 3);
    } finally {
      await cleanup();
    }
  });
}

// --- File-backed-only: corruption and versioning are only meaningfully testable on disk ---

test('[FileRuntimeStore] a corrupted session file is reported as a retrieval error, not silently ignored or crashed on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-corrupt-'));
  try {
    const store = new FileRuntimeStore({ rootDir: dir, now });
    await store.sessions.create(fixtureSession('to-corrupt'));
    await writeFile(join(dir, 'sessions', 'to-corrupt.json'), '{ not valid json at all', 'utf8');
    const result = await store.sessions.get(SessionId('to-corrupt'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_RUNTIME_RETRIEVAL_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[FileRuntimeStore] a tampered (checksum-mismatched) session file is detected as corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-tamper-'));
  try {
    const store = new FileRuntimeStore({ rootDir: dir, now });
    await store.sessions.create(fixtureSession('to-tamper'));
    const path = join(dir, 'sessions', 'to-tamper.json');
    const raw = await (await import('node:fs/promises')).readFile(path, 'utf8');
    await writeFile(path, raw.replace('completed', 'TAMPERED!'), 'utf8');
    const result = await store.sessions.get(SessionId('to-tamper'));
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[FileRuntimeStore] a record written with an unrecognized future version fails clearly if no migration is registered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-version-'));
  try {
    const store = new FileRuntimeStore({ rootDir: dir, now });
    await store.sessions.create(fixtureSession('versioned'));
    const path = join(dir, 'sessions', 'versioned.json');
    await atomicWriteJson(path, { version: 999, persistedAt: 't', data: fixtureSession('versioned') });
    const result = await store.sessions.get(SessionId('versioned'));
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[FileRuntimeStore] records persist across separate FileRuntimeStore instances pointed at the same rootDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-restart-'));
  try {
    const storeA = new FileRuntimeStore({ rootDir: dir, now });
    await storeA.sessions.create(fixtureSession('survives-restart'));

    const storeB = new FileRuntimeStore({ rootDir: dir, now });
    const got = await storeB.sessions.get(SessionId('survives-restart'));
    assert.ok(got.ok && got.value);
    assert.equal(got.value?.data.sessionId, 'survives-restart');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[FileRuntimeStore] checkpoint sequence numbering continues correctly across separate store instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-store-restart-seq-'));
  try {
    const instance = fixtureInstance('wf-restart-seq');
    const storeA = new FileRuntimeStore({ rootDir: dir, now });
    await storeA.checkpoints.save(createCheckpoint(instance, now));
    await storeA.checkpoints.save(createCheckpoint(instance, now));

    const storeB = new FileRuntimeStore({ rootDir: dir, now });
    const saved = await storeB.checkpoints.save(createCheckpoint(instance, now));
    assert.ok(saved.ok);
    if (saved.ok) assert.equal(saved.value.data.sequence, 2, 'a fresh store instance must continue numbering from what is actually on disk, not restart at 0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
