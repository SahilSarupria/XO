import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
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
export const PermissionGraphAdapter: GraphAdapter<PermissionGraphSource> = {
  kind: 'permission-graph',
  toGraphModel(source: PermissionGraphSource): GraphModel {
    const roleNodes: GraphNode[] = source.roles.map((r) => ({
      id: r.id,
      type: 'role',
      label: r.label,
      position: { x: 0, y: 0 },
      ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
    }));
    const resourceNodes: GraphNode[] = source.resources.map((r) => ({
      id: r.id,
      type: 'resource',
      label: r.label,
      position: { x: 0, y: 0 },
      ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.grants.map((g) => ({
      id: g.id,
      type: g.action ?? 'grants',
      source: g.roleId,
      target: g.resourceId,
      ...(g.metadata !== undefined ? { metadata: g.metadata } : {}),
    }));
    return GraphModel.empty().upsertNodes(roleNodes).upsertNodes(resourceNodes).upsertEdges(edges);
  },
};
