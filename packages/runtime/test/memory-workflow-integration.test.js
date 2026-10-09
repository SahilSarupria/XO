import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@xo/types';
import { WorkflowExecutor } from '../src/workflow/workflow-executor.js';
import { NodeId } from '../src/workflow/workflow-graph.js';
import { EnvironmentId } from '../src/ids.js';
import { InMemoryRuntimeStore } from '../src/persistence/in-memory-runtime-store.js';
import { FileRuntimeStore } from '../src/persistence/file/file-runtime-store.js';
import { RuntimeMemory } from '../src/memory/runtime-memory.js';
function environment(overrides = {}) {
    return { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}
// Never actually invoked by these graphs (no `capability` nodes), but required by WorkflowExecutor's constructor.
async function unusedRunner(_request, _cancellation) {
    throw new Error('capability runner should not be called in this test');
}
function memoryGraph(graphId, nodeId) {
    return { graphId, version: '1.0.0', startNodeId: NodeId(nodeId), nodes: [{ id: NodeId(nodeId), type: 'custom:remember' }], edges: [] };
}
test('WorkflowContext.memory is absent when no runtimeMemory is configured (no behavior change from pre-Stage-5)', async () => {
    let sawContext;
    const executor = new WorkflowExecutor(unusedRunner, {
        customNodeHandlers: new Map([
            [
                'custom:remember',
                async (_node, context) => {
                    sawContext = context;
                    return ok({ output: context.memory === undefined ? 'no-memory' : 'has-memory' });
                },
            ],
        ]),
    });
    const result = await executor.run(memoryGraph('g-no-memory', 'n'), environment());
    assert.equal(result.instance.status, 'completed');
    assert.equal(result.instance.state.outputs['n'], 'no-memory');
    assert.ok(sawContext);
});
test('WorkflowContext.memory is scoped to the workflow instance: a node handler can write and read it back within the same run', async () => {
    const runtimeMemory = new RuntimeMemory();
    const executor = new WorkflowExecutor(unusedRunner, {
        runtimeMemory,
        customNodeHandlers: new Map([
            [
                'custom:remember',
                async (_node, context) => {
                    if (!context.memory)
                        return ok({ output: 'no-memory' });
                    await context.memory.put({ type: 'context', key: 'seen', value: 'yes' });
                    const listed = await context.memory.query();
                    if (!listed.ok || listed.value.length !== 1)
                        return ok({ output: 'unexpected-query-result' });
                    const readBack = await context.memory.get(listed.value[0].data.id);
                    return ok({ output: readBack.ok ? readBack.value?.data.value : undefined });
                },
            ],
        ]),
    });
    const result = await executor.run(memoryGraph('g-memory', 'n'), environment());
    assert.equal(result.instance.status, 'completed');
    assert.equal(result.instance.state.outputs['n'], 'yes');
});
test('two separate workflow runs (different workflowInstanceId) get isolated workflow-scoped memory', async () => {
    const runtimeMemory = new RuntimeMemory();
    const writes = [];
    const executor = new WorkflowExecutor(unusedRunner, {
        runtimeMemory,
        customNodeHandlers: new Map([
            [
                'custom:remember',
                async (_node, context) => {
                    if (!context.memory)
                        return ok({ output: undefined });
                    await context.memory.put({ type: 'context', key: 'note', value: context.workflowInstanceId });
                    writes.push(context.workflowInstanceId);
                    const existing = await context.memory.query();
                    return ok({ output: existing.ok ? existing.value.length : -1 });
                },
            ],
        ]),
    });
    const runA = await executor.run(memoryGraph('g-a', 'n'), environment());
    const runB = await executor.run(memoryGraph('g-b', 'n'), environment());
    assert.equal(runA.instance.status, 'completed');
    assert.equal(runB.instance.status, 'completed');
    // Each run's own workflow scope sees exactly its own single write, never the other run's.
    assert.equal(runA.instance.state.outputs['n'], 1);
    assert.equal(runB.instance.state.outputs['n'], 1);
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0], writes[1]);
});
test('RuntimeStore.memory is wired through both InMemoryRuntimeStore and FileRuntimeStore, and RuntimeMemory can be built directly on top of it', async () => {
    const inMemoryStore = new InMemoryRuntimeStore();
    const runtimeMemoryA = new RuntimeMemory(inMemoryStore.memory);
    const putResult = await runtimeMemoryA.put({ scope: { kind: 'runtime', scopeId: 'global' }, type: 'fact', key: 'version', value: '1.0.0' });
    assert.equal(putResult.ok, true);
    const dir = await mkdtemp(join(tmpdir(), 'xo-memory-runtimestore-'));
    try {
        const fileStore = new FileRuntimeStore({ rootDir: dir });
        const runtimeMemoryB = new RuntimeMemory(fileStore.memory);
        await runtimeMemoryB.put({ scope: { kind: 'runtime', scopeId: 'global' }, type: 'fact', key: 'version', value: '2.0.0' });
        // A brand-new FileRuntimeStore over the same directory (simulated restart) sees the durable write.
        const restarted = new FileRuntimeStore({ rootDir: dir });
        const restartedMemory = new RuntimeMemory(restarted.memory);
        const listed = await restartedMemory.query({ kind: 'runtime', scopeId: 'global' });
        assert.equal(listed.ok && listed.value.length, 1);
        assert.equal(listed.ok && listed.value[0]?.data.value, '2.0.0');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=memory-workflow-integration.test.js.map