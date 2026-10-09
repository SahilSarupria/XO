import { brand } from './brand.js';
export const PackageId = (value) => brand(value);
export const CreatorDid = (value) => brand(value);
export const BenchmarkRunId = (value) => brand(value);
export const LicenseId = (value) => brand(value);
export const ContentHash = (value) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new TypeError(`ContentHash must match "sha256:<64 hex chars>", got: ${value}`);
    }
    return brand(value);
};
//# sourceMappingURL=ids.js.map