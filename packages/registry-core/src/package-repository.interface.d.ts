import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';
import type { XoManifest } from '@xo/types';
export interface PackageRecord {
    readonly id: string;
    readonly manifest: XoManifest;
    readonly publishedAt: string;
}
/** Registry-side persistence for published XO packages. No implementation lives here — see SPECIFICATION.md for what "publish" must verify (signatures, Merkle root) before a record is ever written. */
export interface PackageRepository {
    publish(record: PackageRecord): Promise<Result<void, XoError>>;
    get(id: string): Promise<Result<PackageRecord, NotFoundError>>;
    listByCreator(creatorDid: string): Promise<readonly PackageRecord[]>;
}
//# sourceMappingURL=package-repository.interface.d.ts.map