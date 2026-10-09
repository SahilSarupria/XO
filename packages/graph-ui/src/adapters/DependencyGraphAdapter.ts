import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface DependencyGraphPackage {
  readonly id: string;
  readonly label: string;
  readonly version?: string;
  readonly metadata?: GraphMetadata;
}

export interface DependencyGraphDependency {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly versionRange?: string;
  readonly metadata?: GraphMetadata;
}

export interface DependencyGraphSource {
  readonly packages: readonly DependencyGraphPackage[];
  readonly dependencies: readonly DependencyGraphDependency[];
}

/** Converts a package/dependency graph into a generic GraphModel. */
export const DependencyGraphAdapter: GraphAdapter<DependencyGraphSource> = {
  kind: 'dependency-graph',
  toGraphModel(source: DependencyGraphSource): GraphModel {
    const nodes: GraphNode[] = source.packages.map((p) => ({
      id: p.id,
      type: 'package',
      label: p.version ? `${p.label}@${p.version}` : p.label,
      position: { x: 0, y: 0 },
      ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.dependencies.map((d) => ({
      id: d.id,
      type: 'depends_on',
      source: d.from,
      target: d.to,
      ...(d.versionRange !== undefined ? { label: d.versionRange } : {}),
      ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
    }));
    return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
  },
};
