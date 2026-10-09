import { GraphModel } from '../model/GraphModel.js';
import type { EdgeGroup, GraphEdge, GraphNode, NodeGroup } from '../model/types.js';

export interface GraphModelJson {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly nodeGroups: readonly NodeGroup[];
  readonly edgeGroups: readonly EdgeGroup[];
}

/** Serializes a GraphModel to a JSON-serializable plain object. */
export function modelToJsonObject(model: GraphModel): GraphModelJson {
  return {
    nodes: model.nodes,
    edges: model.edges,
    nodeGroups: model.nodeGroups,
    edgeGroups: model.edgeGroups,
  };
}

/** Serializes a GraphModel to a JSON string. */
export function exportModelToJson(model: GraphModel, pretty = false): string {
  return JSON.stringify(modelToJsonObject(model), null, pretty ? 2 : undefined);
}

/** Rebuilds a GraphModel from a plain object previously produced by modelToJsonObject. */
export function modelFromJsonObject(json: GraphModelJson): GraphModel {
  return new GraphModel({
    nodes: json.nodes,
    edges: json.edges,
    nodeGroups: json.nodeGroups,
    edgeGroups: json.edgeGroups,
  });
}

/** Rebuilds a GraphModel from a JSON string previously produced by exportModelToJson. */
export function importModelFromJson(json: string): GraphModel {
  return modelFromJsonObject(JSON.parse(json) as GraphModelJson);
}
