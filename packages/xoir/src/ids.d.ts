import { type Brand } from '@xo/types';
/**
 * XOIR has its own identifier space, distinct from `@xo/types`' registry-
 * level IDs (`PackageId`, `LicenseId`, ...). A `XoirNodeId` identifies a
 * node *within a graph*, not a published artifact.
 */
export type XoirNodeId = Brand<string, 'XoirNodeId'>;
export type XoirEdgeId = Brand<string, 'XoirEdgeId'>;
export type XoirGraphId = Brand<string, 'XoirGraphId'>;
export declare const XoirNodeId: (value: string) => XoirNodeId;
export declare const XoirEdgeId: (value: string) => XoirEdgeId;
export declare const XoirGraphId: (value: string) => XoirGraphId;
//# sourceMappingURL=ids.d.ts.map