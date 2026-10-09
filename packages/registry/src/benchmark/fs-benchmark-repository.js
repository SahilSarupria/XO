import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, RegistryError } from '@xo/errors';
function runKey(id) {
    return `benchmarks/runs/${encodeURIComponent(id)}.json`;
}
function packageIndexKey(packageId, runId) {
    return `benchmarks/by-package/${encodeURIComponent(packageId)}/${encodeURIComponent(runId)}.json`;
}
/**
 * Local-filesystem `BenchmarkRepository`. Keeps the "falsifiable trust"
 * framing `BenchmarkRepository`'s own docstring calls out front and
 * center: a recorded {@link BenchmarkRun} is stored verbatim, byte for
 * byte, exactly as submitted — this repository never summarizes,
 * aggregates, or discards a run's inputs, because a claim that can't be
 * re-run and challenged later isn't "falsifiable trust", it's just an
 * assertion. (Re-running and adjudicating a challenge is a consumer's
 * job, not this repository's — see the README's "Not yet in scope".)
 */
export class FsBenchmarkRepository {
    store;
    constructor(store) {
        this.store = store;
    }
    async record(run) {
        if (await this.store.has(runKey(run.id))) {
            return err(new RegistryError(ErrorCode.REGISTRY_BENCHMARK_ALREADY_RECORDED, `Benchmark run "${run.id}" is already recorded — each run id must be recorded exactly once`));
        }
        const payload = JSON.stringify(run);
        const putRun = await this.store.put(runKey(run.id), payload);
        if (!putRun.ok)
            return err(putRun.error);
        const putIndex = await this.store.put(packageIndexKey(run.packageId, run.id), payload);
        if (!putIndex.ok)
            return err(putIndex.error);
        return ok(undefined);
    }
    async get(id) {
        const raw = await this.store.get(runKey(id));
        if (!raw.ok)
            return err(new NotFoundError(`Benchmark run "${id}"`));
        try {
            return ok(JSON.parse(new TextDecoder().decode(raw.value)));
        }
        catch {
            return err(new NotFoundError(`Benchmark run "${id}" (stored record is corrupt)`));
        }
    }
    async listForPackage(packageId) {
        const listed = await this.store.list(`benchmarks/by-package/${encodeURIComponent(packageId)}/`);
        if (!listed.ok)
            return [];
        const runs = [];
        for (const key of listed.value) {
            const raw = await this.store.get(key);
            if (!raw.ok)
                continue;
            try {
                runs.push(JSON.parse(new TextDecoder().decode(raw.value)));
            }
            catch {
                // Skip a corrupt index entry rather than failing the whole listing.
            }
        }
        return runs;
    }
}
//# sourceMappingURL=fs-benchmark-repository.js.map