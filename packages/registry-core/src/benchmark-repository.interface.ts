import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

export interface BenchmarkRun {
  readonly id: string;
  readonly packageId: string;
  readonly category: string; // one of benchmark_suite.json's 7 categories
  readonly score: number;
  readonly runAt: string;
  readonly challengeable: boolean;
}

/** Persistence for the "falsifiable trust" system (SPECIFICATION.md §0): every benchmark claim recorded here must be re-runnable and challengeable. */
export interface BenchmarkRepository {
  record(run: BenchmarkRun): Promise<Result<void, XoError>>;
  get(id: string): Promise<Result<BenchmarkRun, NotFoundError>>;
  listForPackage(packageId: string): Promise<readonly BenchmarkRun[]>;
}
