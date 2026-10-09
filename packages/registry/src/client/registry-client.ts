import { randomUUID } from 'node:crypto';
import type { PackageRecord, BenchmarkRun, LicenseRecord, RoyaltySplit, Ledger } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { err, ok, BenchmarkRunId, LicenseId } from '@xo/types';
import { ErrorCode, RegistryError, type NotFoundError, type XoError } from '@xo/errors';
import { PackageValidator, type PackageBundle } from '@xo/package-sdk';
import type { BlobStore } from '@xo/storage';
import { FsPackageRepository } from '../package/fs-package-repository.js';
import { FsBenchmarkRepository } from '../benchmark/fs-benchmark-repository.js';
import { FsLicenseRepository } from '../license/fs-license-repository.js';
import { HashChainedLedger } from '../ledger/hash-chained-ledger.js';
import type { Clock } from '../clock.js';
import { SystemClock } from '../clock.js';

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
export type WithLedgerEntry<T> = T & { readonly ledgerEntryHash: string };

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
export class RegistryClient {
  private readonly packages: FsPackageRepository;
  private readonly benchmarks: FsBenchmarkRepository;
  private readonly licenses: FsLicenseRepository;
  private readonly ledger: Ledger;
  private readonly validator: PackageValidator;
  private readonly clock: Clock;

  constructor(store: BlobStore, options: RegistryClientOptions = {}) {
    this.packages = options.packages ?? new FsPackageRepository(store);
    this.benchmarks = options.benchmarks ?? new FsBenchmarkRepository(store);
    this.licenses = options.licenses ?? new FsLicenseRepository(store);
    this.ledger = options.ledger ?? new HashChainedLedger(store);
    this.validator = options.validator ?? new PackageValidator();
    this.clock = options.clock ?? new SystemClock();
  }

  /**
   * Verifies `bundle` in full (schema, version, no-duplicate-paths,
   * required components, capabilities, dependencies, component hashes,
   * Merkle root, and signatures where a public-key resolver was
   * supplied to the `PackageValidator`) and only then publishes it,
   * content-addressed by its own `manifest.merkleRoot`.
   */
  async publish(bundle: PackageBundle): Promise<Result<WithLedgerEntry<PackageRecord>, XoError>> {
    const report = this.validator.validateAll(bundle);
    if (!report.valid) {
      const errors = report.issues.filter((issue) => issue.severity === 'error');
      const summary = errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
      return err(
        new RegistryError(
          ErrorCode.REGISTRY_PACKAGE_UNVERIFIED,
          `Package "${bundle.manifest.name}@${bundle.manifest.version}" failed verification and was not published: ${summary}`,
        ),
      );
    }

    // validateAll() passing guarantees merkleRoot is present and correct
    // (validateMerkleRoot is one of the checks it runs), so this is safe.
    const id = bundle.manifest.merkleRoot as string;
    const record: PackageRecord = { id, manifest: bundle.manifest, publishedAt: this.clock.now().toISOString() };

    const published = await this.packages.publish(record);
    if (!published.ok) return err(published.error);

    const appended = await this.ledger.append(id);
    if (!appended.ok) return err(appended.error);

    return ok({ ...record, ledgerEntryHash: appended.value.entryHash });
  }

  async get(id: string): Promise<Result<PackageRecord, NotFoundError>> {
    return this.packages.get(id);
  }

  async listByCreator(creatorDid: string): Promise<readonly PackageRecord[]> {
    return this.packages.listByCreator(creatorDid);
  }

  /**
   * Case-insensitive substring search over every published package's
   * name, creator DID, and declared capability ids/names/descriptions.
   * Not part of `PackageRepository` (see `FsPackageRepository.listAll()`'s
   * own docstring) — this is `RegistryClient` doing the catalog-wide scan
   * a real networked registry service would instead push down to a query
   * engine or search index. Fine for the package counts this sandbox
   * will ever see; the seam to swap in real search is `listAll()` itself.
   */
  async search(query: string): Promise<readonly PackageRecord[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    const all = await this.packages.listAll();
    return all.filter((record) => {
      const manifest = record.manifest;
      if (manifest.name.toLowerCase().includes(needle)) return true;
      if (manifest.creatorDid.toLowerCase().includes(needle)) return true;
      return (manifest.capabilities ?? []).some(
        (capability) =>
          capability.id.toLowerCase().includes(needle) ||
          capability.name.toLowerCase().includes(needle) ||
          capability.description.toLowerCase().includes(needle),
      );
    });
  }

  async recordBenchmark(input: RecordBenchmarkInput): Promise<Result<WithLedgerEntry<BenchmarkRun>, XoError>> {
    const run: BenchmarkRun = {
      id: BenchmarkRunId(randomUUID()),
      packageId: input.packageId,
      category: input.category,
      score: input.score,
      runAt: this.clock.now().toISOString(),
      challengeable: input.challengeable ?? true,
    };

    const recorded = await this.benchmarks.record(run);
    if (!recorded.ok) return err(recorded.error);

    const appended = await this.ledger.append(run.id);
    if (!appended.ok) return err(appended.error);

    return ok({ ...run, ledgerEntryHash: appended.value.entryHash });
  }

  async getBenchmark(id: string): Promise<Result<BenchmarkRun, NotFoundError>> {
    return this.benchmarks.get(id);
  }

  async listBenchmarksForPackage(packageId: string): Promise<readonly BenchmarkRun[]> {
    return this.benchmarks.listForPackage(packageId);
  }

  async createLicense(input: CreateLicenseInput): Promise<Result<WithLedgerEntry<LicenseRecord>, XoError>> {
    const record: LicenseRecord = {
      id: LicenseId(randomUUID()),
      packageId: input.packageId,
      tier: input.tier,
      royaltySplit: input.royaltySplit,
    };

    const created = await this.licenses.create(record);
    if (!created.ok) return err(created.error);

    const appended = await this.ledger.append(record.id);
    if (!appended.ok) return err(appended.error);

    return ok({ ...record, ledgerEntryHash: appended.value.entryHash });
  }

  async getLicense(id: string): Promise<Result<LicenseRecord, NotFoundError>> {
    return this.licenses.get(id);
  }

  /** Recomputes and checks a ledger entry's hash chain back to genesis — see `HashChainedLedger.verify()`. */
  async verifyLedgerEntry(entryHash: string): Promise<boolean> {
    return this.ledger.verify(entryHash);
  }
}
