import type { LicenseRepository, LicenseRecord } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { NotFoundError, type XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
/**
 * Validates that a {@link LicenseRecord}'s `royaltySplit` basis points sum
 * to exactly {@link REQUIRED_BASIS_POINTS_TOTAL} (10000 = 100.00%), per
 * `license-repository.interface.ts`'s own comment: "must sum to 10000
 * across a license, per SPECIFICATION.md §4". This is a real invariant a
 * caller must satisfy, not a suggestion — an empty split, a split that
 * over- or under-allocates, or a split with a negative `basisPoints` are
 * all rejected here, never silently normalized or clamped.
 */
export declare function validateRoyaltySplit(royaltySplit: readonly LicenseRecord['royaltySplit'][number][]): string | undefined;
/**
 * Local-filesystem `LicenseRepository`. `create()` is the boundary
 * `license-repository.interface.ts` calls out for enforcing the basis-
 * points-sum-to-10000 invariant — validated here via
 * {@link validateRoyaltySplit} before a single byte is written, so an
 * invalid `LicenseRecord` never reaches storage even transiently.
 */
export declare class FsLicenseRepository implements LicenseRepository {
    private readonly store;
    constructor(store: BlobStore);
    create(record: LicenseRecord): Promise<Result<void, XoError>>;
    get(id: string): Promise<Result<LicenseRecord, NotFoundError>>;
}
//# sourceMappingURL=fs-license-repository.d.ts.map