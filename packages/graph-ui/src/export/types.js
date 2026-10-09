export function selectionStateToSnapshot(selection) {
    return {
        nodeIds: [...selection.nodeIds],
        edgeIds: [...selection.edgeIds],
        groupIds: [...selection.groupIds],
    };
}
//# sourceMappingURL=types.js.map