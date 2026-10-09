import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

export interface RoyaltySplit {
  readonly role: 'creator' | 'reviewer' | 'dataset_contributor' | 'platform';
  readonly basisPoints: number; // must sum to 10000 across a license, per SPECIFICATION.md §4
}

export interface LicenseRecord {
  readonly id: string;
  readonly packageId: string;
  readonly tier: string;
  readonly royaltySplit: readonly RoyaltySplit[];
}

export interface LicenseRepository {
  create(record: LicenseRecord): Promise<Result<void, XoError>>;
  get(id: string): Promise<Result<LicenseRecord, NotFoundError>>;
}
