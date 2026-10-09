import type { BenchmarkRepository, BenchmarkRun } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { NotFoundError, type XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
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
export declare class FsBenchmarkRepository implements BenchmarkRepository {
    private readonly store;
    constructor(store: BlobStore);
    record(run: BenchmarkRun): Promise<Result<void, XoError>>;
    get(id: string): Promise<Result<BenchmarkRun, NotFoundError>>;
    listForPackage(packageId: string): Promise<readonly BenchmarkRun[]>;
}
//# sourceMappingURL=fs-benchmark-repository.d.ts.map