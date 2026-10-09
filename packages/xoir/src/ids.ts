import { brand, type Brand } from '@xo/types';

/**
 * XOIR has its own identifier space, distinct from `@xo/types`' registry-
 * level IDs (`PackageId`, `LicenseId`, ...). A `XoirNodeId` identifies a
 * node *within a graph*, not a published artifact.
 */
export type XoirNodeId = Brand<string, 'XoirNodeId'>;
export type XoirEdgeId = Brand<string, 'XoirEdgeId'>;
export type XoirGraphId = Brand<string, 'XoirGraphId'>;

export const XoirNodeId = (value: string): XoirNodeId => brand(value);
export const XoirEdgeId = (value: string): XoirEdgeId => brand(value);
export const XoirGraphId = (value: string): XoirGraphId => brand(value);