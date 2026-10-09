import { type Brand } from './brand.js';
export type PackageId = Brand<string, 'PackageId'>;
export type CreatorDid = Brand<string, 'CreatorDid'>;
export type BenchmarkRunId = Brand<string, 'BenchmarkRunId'>;
export type LicenseId = Brand<string, 'LicenseId'>;
export type ContentHash = Brand<string, 'ContentHash'>;
export declare const PackageId: (value: string) => PackageId;
export declare const CreatorDid: (value: string) => CreatorDid;
export declare const BenchmarkRunId: (value: string) => BenchmarkRunId;
export declare const LicenseId: (value: string) => LicenseId;
export declare const ContentHash: (value: string) => ContentHash;
//# sourceMappingURL=ids.d.ts.map