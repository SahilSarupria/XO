import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface PermissionGraphRole {
    readonly id: string;
    readonly label: string;
    readonly metadata?: GraphMetadata;
}
export interface PermissionGraphResource {
    readonly id: string;
    readonly label: string;
    readonly metadata?: GraphMetadata;
}
export interface PermissionGraphGrant {
    readonly id: string;
    readonly roleId: string;
    readonly resourceId: string;
    readonly action?: string;
    readonly metadata?: GraphMetadata;
}
export interface PermissionGraphSource {
    readonly roles: readonly PermissionGraphRole[];
    readonly resources: readonly PermissionGraphResource[];
    readonly grants: readonly PermissionGraphGrant[];
}
/** Converts roles/resources/grants into a generic GraphModel. */
export declare const PermissionGraphAdapter: GraphAdapter<PermissionGraphSource>;
//# sourceMappingURL=PermissionGraphAdapter.d.ts.map