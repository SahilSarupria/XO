import { GraphModel } from '../model/GraphModel.js';
import type { EdgeGroup, GraphEdge, GraphNode, NodeGroup } from '../model/types.js';
export interface GraphModelJson {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
    readonly nodeGroups: readonly NodeGroup[];
    readonly edgeGroups: readonly EdgeGroup[];
}
/** Serializes a GraphModel to a JSON-serializable plain object. */
export declare function modelToJsonObject(model: GraphModel): GraphModelJson;
/** Serializes a GraphModel to a JSON string. */
export declare function exportModelToJson(model: GraphModel, pretty?: boolean): string;
/** Rebuilds a GraphModel from a plain object previously produced by modelToJsonObject. */
export declare function modelFromJsonObject(json: GraphModelJson): GraphModel;
/** Rebuilds a GraphModel from a JSON string previously produced by exportModelToJson. */
export declare function importModelFromJson(json: string): GraphModel;
//# sourceMappingURL=toJson.d.ts.map