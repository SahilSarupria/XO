import type { PackageRepository, PackageRecord } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { NotFoundError, type XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
/**
 * Local-filesystem `PackageRepository`, content-addressed by the
 * manifest's own `merkleRoot` (per the task brief: "content-addressed by
 * the package's existing Merkle root rather than inventing a new ID
 * scheme") rather than an incrementing counter or a random UUID a caller
 * could collide with independently of package content.
 *
 * **Verification boundary.** `PackageRepository.publish()` is a frozen
 * interface that only receives a `PackageRecord` (`id` + `manifest` +
 * `publishedAt`) — it never sees component bytes, so it cannot itself run
 * `PackageValidator.validateAll()`, which needs a full `PackageBundle` to
 * check component hashes and the Merkle root against real data. This
 * repository still refuses anything it *can* check from the manifest
 * alone (schema shape, a `merkleRoot` that's actually present, and that
 * the caller isn't lying about `id` not matching `manifest.merkleRoot`)
 * as defense-in-depth, but the authoritative hash/Merkle/signature
 * verification — "never trust an unverified manifest" — happens one
 * layer up, in `RegistryClient.publish()`, which *does* receive the full
 * `PackageBundle` and runs `PackageValidator.validateAll()` on it before
 * ever constructing the `PackageRecord` this method is handed. See this
 * package's README, "Why verification happens in `RegistryClient`, not
 * here", for the full reasoning.
 */
export declare class FsPackageRepository implements PackageRepository {
    private readonly store;
    constructor(store: BlobStore);
    publish(record: PackageRecord): Promise<Result<void, XoError>>;
    get(id: string): Promise<Result<PackageRecord, NotFoundError>>;
    listByCreator(creatorDid: string): Promise<readonly PackageRecord[]>;
    /**
     * Lists every published package, regardless of creator. Not part of
     * `PackageRepository` — that frozen interface only offers
     * `listByCreator`, deliberately (it's a per-creator registry API, not
     * a full-catalog browse). `RegistryClient.search()` needs "every
     * package" as its starting point, so this is exposed as an extra
     * method on the concrete implementation rather than smuggled into the
     * interface.
     */
    listAll(): Promise<readonly PackageRecord[]>;
}
//# sourceMappingURL=fs-package-repository.d.ts.map