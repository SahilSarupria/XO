import type { PackageRecord, BenchmarkRun, LicenseRecord, RoyaltySplit, Ledger } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { type NotFoundError, type XoError } from '@xo/errors';
import { PackageValidator, type PackageBundle } from '@xo/package-sdk';
import type { BlobStore } from '@xo/storage';
import { FsPackageRepository } from '../package/fs-package-repository.js';
import { FsBenchmarkRepository } from '../benchmark/fs-benchmark-repository.js';
import { FsLicenseRepository } from '../license/fs-license-repository.js';
import type { Clock } from '../clock.js';
export interface RegistryClientOptions {
    readonly packages?: FsPackageRepository;
    readonly benchmarks?: FsBenchmarkRepository;
    readonly licenses?: FsLicenseRepository;
    readonly ledger?: Ledger;
    readonly validator?: PackageValidator;
    readonly clock?: Clock;
}
/**
 * `Ledger.append()` returns a `LedgerEntry` keyed by its own `entryHash`
 * — not by the `payloadHash` (here, the package/benchmark/license id) it
 * was appended for. A caller who only has the domain record has no way
 * to ask "was this verified?" without also knowing the ledger's internal
 * entry hash, so every mutating `RegistryClient` method returns its
 * domain record *plus* `ledgerEntryHash`, the value `verifyLedgerEntry()`
 * actually expects.
 */
export type WithLedgerEntry<T> = T & {
    readonly ledgerEntryHash: string;
};
export interface RecordBenchmarkInput {
    readonly packageId: string;
    readonly category: string;
    readonly score: number;
    readonly challengeable?: boolean;
}
export interface CreateLicenseInput {
    readonly packageId: string;
    readonly tier: string;
    readonly royaltySplit: readonly RoyaltySplit[];
}
/**
 * One ergonomic entry point over `@xo/registry-core`'s four repositories
 * plus the ledger, so callers (the CLI's `registry` command group today;
 * `@xo/package-sdk` or other packages later) wire up one object instead
 * of four repositories and a validator individually.
 *
 * **This is where publish-time verification actually happens.**
 * `FsPackageRepository.publish()` only ever sees a `PackageRecord`
 * (manifest + id + timestamp — no component bytes), so it cannot run the
 * full hash/Merkle/signature check `PackageValidator.validateAll()`
 * performs against a `PackageBundle`. `RegistryClient.publish()` is the
 * layer that *does* receive the full bundle, and it runs
 * `validateAll()` and rejects anything with a validation error before
 * ever constructing the `PackageRecord` the repository writes — "never
 * trust an unverified manifest" is enforced here, not smuggled into the
 * frozen interface. See this package's README for the full reasoning.
 *
 * Every mutating call that succeeds also appends to the `Ledger` —
 * `publish`, `recordBenchmark`, and `createLicense` all leave an
 * append-only audit trail keyed by the same content hash the record
 * itself is addressed by (for packages) or a fresh id (for benchmark
 * runs and licenses, which aren't themselves content-addressed).
 */
export declare class RegistryClient {
    private readonly packages;
    private readonly benchmarks;
    private readonly licenses;
    private readonly ledger;
    private readonly validator;
    private readonly clock;
    constructor(store: BlobStore, options?: RegistryClientOptions);
    /**
     * Verifies `bundle` in full (schema, version, no-duplicate-paths,
     * required components, capabilities, dependencies, component hashes,
     * Merkle root, and signatures where a public-key resolver was
     * supplied to the `PackageValidator`) and only then publishes it,
     * content-addressed by its own `manifest.merkleRoot`.
     */
    publish(bundle: PackageBundle): Promise<Result<WithLedgerEntry<PackageRecord>, XoError>>;
    get(id: string): Promise<Result<PackageRecord, NotFoundError>>;
    listByCreator(creatorDid: string): Promise<readonly PackageRecord[]>;
    /**
     * Case-insensitive substring search over every published package's
     * name, creator DID, and declared capability ids/names/descriptions.
     * Not part of `PackageRepository` (see `FsPackageRepository.listAll()`'s
     * own docstring) — this is `RegistryClient` doing the catalog-wide scan
     * a real networked registry service would instead push down to a query
     * engine or search index. Fine for the package counts this sandbox
     * will ever see; the seam to swap in real search is `listAll()` itself.
     */
    search(query: string): Promise<readonly PackageRecord[]>;
    recordBenchmark(input: RecordBenchmarkInput): Promise<Result<WithLedgerEntry<BenchmarkRun>, XoError>>;
    getBenchmark(id: string): Promise<Result<BenchmarkRun, NotFoundError>>;
    listBenchmarksForPackage(packageId: string): Promise<readonly BenchmarkRun[]>;
    createLicense(input: CreateLicenseInput): Promise<Result<WithLedgerEntry<LicenseRecord>, XoError>>;
    getLicense(id: string): Promise<Result<LicenseRecord, NotFoundError>>;
    /** Recomputes and checks a ledger entry's hash chain back to genesis — see `HashChainedLedger.verify()`. */
    verifyLedgerEntry(entryHash: string): Promise<boolean>;
}
//# sourceMappingURL=registry-client.d.ts.map