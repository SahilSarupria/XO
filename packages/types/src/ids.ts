import { brand, type Brand } from './brand.js';

export type PackageId = Brand<string, 'PackageId'>;
export type CreatorDid = Brand<string, 'CreatorDid'>;
export type BenchmarkRunId = Brand<string, 'BenchmarkRunId'>;
export type LicenseId = Brand<string, 'LicenseId'>;
export type ContentHash = Brand<string, 'ContentHash'>; // "sha256:<hex>"

export const PackageId = (value: string): PackageId => brand(value);
export const CreatorDid = (value: string): CreatorDid => brand(value);
export const BenchmarkRunId = (value: string): BenchmarkRunId => brand(value);
export const LicenseId = (value: string): LicenseId => brand(value);
export const ContentHash = (value: string): ContentHash => {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`ContentHash must match "sha256:<64 hex chars>", got: ${value}`);
  }
  return brand(value);
};
