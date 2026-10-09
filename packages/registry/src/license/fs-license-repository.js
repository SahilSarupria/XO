import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, RegistryError } from '@xo/errors';
const REQUIRED_BASIS_POINTS_TOTAL = 10000;
function licenseKey(id) {
    return `licenses/records/${encodeURIComponent(id)}.json`;
}
/**
 * Validates that a {@link LicenseRecord}'s `royaltySplit` basis points sum
 * to exactly {@link REQUIRED_BASIS_POINTS_TOTAL} (10000 = 100.00%), per
 * `license-repository.interface.ts`'s own comment: "must sum to 10000
 * across a license, per SPECIFICATION.md §4". This is a real invariant a
 * caller must satisfy, not a suggestion — an empty split, a split that
 * over- or under-allocates, or a split with a negative `basisPoints` are
 * all rejected here, never silently normalized or clamped.
 */
export function validateRoyaltySplit(royaltySplit) {
    if (royaltySplit.length === 0) {
        return 'royaltySplit must declare at least one recipient';
    }
    let total = 0;
    for (const split of royaltySplit) {
        if (!Number.isInteger(split.basisPoints) || split.basisPoints < 0) {
            return `royaltySplit entry for role "${split.role}" has an invalid basisPoints value (${split.basisPoints}) — must be a non-negative integer`;
        }
        total += split.basisPoints;
    }
    if (total !== REQUIRED_BASIS_POINTS_TOTAL) {
        return `royaltySplit basis points must sum to exactly ${REQUIRED_BASIS_POINTS_TOTAL}, got ${total}`;
    }
    return undefined;
}
/**
 * Local-filesystem `LicenseRepository`. `create()` is the boundary
 * `license-repository.interface.ts` calls out for enforcing the basis-
 * points-sum-to-10000 invariant — validated here via
 * {@link validateRoyaltySplit} before a single byte is written, so an
 * invalid `LicenseRecord` never reaches storage even transiently.
 */
export class FsLicenseRepository {
    store;
    constructor(store) {
        this.store = store;
    }
    async create(record) {
        const validationError = validateRoyaltySplit(record.royaltySplit);
        if (validationError) {
            return err(new RegistryError(ErrorCode.REGISTRY_ROYALTY_SPLIT_INVALID, `License "${record.id}" was not created: ${validationError}`));
        }
        if (await this.store.has(licenseKey(record.id))) {
            return err(new RegistryError(ErrorCode.REGISTRY_LICENSE_ALREADY_EXISTS, `License "${record.id}" already exists`));
        }
        const putResult = await this.store.put(licenseKey(record.id), JSON.stringify(record));
        if (!putResult.ok)
            return err(putResult.error);
        return ok(undefined);
    }
    async get(id) {
        const raw = await this.store.get(licenseKey(id));
        if (!raw.ok)
            return err(new NotFoundError(`License "${id}"`));
        try {
            return ok(JSON.parse(new TextDecoder().decode(raw.value)));
        }
        catch {
            return err(new NotFoundError(`License "${id}" (stored record is corrupt)`));
        }
    }
}
//# sourceMappingURL=fs-license-repository.js.map