import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsBenchmarkRepository } from '../src/benchmark/fs-benchmark-repository.js';
import { withTempStore } from './test-helpers.js';
function sampleRun(overrides = {}) {
    return {
        id: overrides.id ?? 'run-1',
        packageId: overrides.packageId ?? 'sha256:' + 'a'.repeat(64),
        category: overrides.category ?? 'contract_analysis',
        score: overrides.score ?? 0.87,
        runAt: '2026-01-01T00:00:00.000Z',
        challengeable: true,
    };
}
test('record() then get() round-trips a benchmark run, inputs and all', async () => {
    await withTempStore(async (store) => {
        const repo = new FsBenchmarkRepository(store);
        const run = sampleRun();
        const recorded = await repo.record(run);
        assert.equal(recorded.ok, true);
        const fetched = await repo.get(run.id);
        assert.equal(fetched.ok, true);
        if (!fetched.ok)
            return;
        assert.deepEqual(fetched.value, run);
    });
});
test('record() rejects recording the same run id twice', async () => {
    await withTempStore(async (store) => {
        const repo = new FsBenchmarkRepository(store);
        const run = sampleRun();
        const first = await repo.record(run);
        assert.equal(first.ok, true);
        const second = await repo.record(run);
        assert.equal(second.ok, false);
        if (second.ok)
            return;
        assert.equal(second.error.code, 'XO_REGISTRY_BENCHMARK_ALREADY_RECORDED');
    });
});
test('get() on an unrecorded id returns NotFoundError', async () => {
    await withTempStore(async (store) => {
        const repo = new FsBenchmarkRepository(store);
        const result = await repo.get('does-not-exist');
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.equal(result.error.code, 'XO_NOT_FOUND');
    });
});
test('listForPackage() returns every run for that package across categories, and none for others', async () => {
    await withTempStore(async (store) => {
        const repo = new FsBenchmarkRepository(store);
        const packageA = 'sha256:' + 'a'.repeat(64);
        const packageB = 'sha256:' + 'b'.repeat(64);
        await repo.record(sampleRun({ id: 'run-a1', packageId: packageA, category: 'contract_analysis' }));
        await repo.record(sampleRun({ id: 'run-a2', packageId: packageA, category: 'fraud_detection' }));
        await repo.record(sampleRun({ id: 'run-b1', packageId: packageB, category: 'contract_analysis' }));
        const runsForA = await repo.listForPackage(packageA);
        assert.equal(runsForA.length, 2);
        assert.deepEqual(runsForA.map((r) => r.id).sort(), ['run-a1', 'run-a2']);
        const runsForB = await repo.listForPackage(packageB);
        assert.equal(runsForB.length, 1);
        assert.equal(runsForB[0]?.id, 'run-b1');
    });
});
test('listForPackage() for a package with no runs returns an empty list', async () => {
    await withTempStore(async (store) => {
        const repo = new FsBenchmarkRepository(store);
        const runs = await repo.listForPackage('sha256:' + '0'.repeat(64));
        assert.deepEqual(runs, []);
    });
});
//# sourceMappingURL=fs-benchmark-repository.test.js.map