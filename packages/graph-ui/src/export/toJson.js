import { GraphModel } from '../model/GraphModel.js';
/** Serializes a GraphModel to a JSON-serializable plain object. */
export function modelToJsonObject(model) {
    return {
        nodes: model.nodes,
        edges: model.edges,
        nodeGroups: model.nodeGroups,
        edgeGroups: model.edgeGroups,
    };
}
/** Serializes a GraphModel to a JSON string. */
export function exportModelToJson(model, pretty = false) {
    return JSON.stringify(modelToJsonObject(model), null, pretty ? 2 : undefined);
}
/** Rebuilds a GraphModel from a plain object previously produced by modelToJsonObject. */
export function modelFromJsonObject(json) {
    return new GraphModel({
        nodes: json.nodes,
        edges: json.edges,
        nodeGroups: json.nodeGroups,
        edgeGroups: json.edgeGroups,
    });
}
/** Rebuilds a GraphModel from a JSON string previously produced by exportModelToJson. */
export function importModelFromJson(json) {
    return modelFromJsonObject(JSON.parse(json));
}
//# sourceMappingURL=toJson.js.map