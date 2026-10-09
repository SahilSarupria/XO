import { SemanticZoomRegistry } from '@xo/atlas';
const FIELD_RANGE = {
    identity: { appearsAt: 0, fullyVisibleAt: 2 },
    capabilities: { appearsAt: 2, fullyVisibleAt: 3 },
    workflows: { appearsAt: 3, fullyVisibleAt: 4 },
    reasoning: { appearsAt: 4, fullyVisibleAt: 5 },
    memory: { appearsAt: 5, fullyVisibleAt: 6 },
    execution: { appearsAt: 6, fullyVisibleAt: 7 },
};
/**
 * Builds a SemanticZoomRegistry with one rule per (XO, field) pair,
 * reusing Atlas's registry directly rather than inventing a second
 * visibility system, per requirement 6.
 */
export function buildMarketplaceSemanticZoom(world) {
    const registry = new SemanticZoomRegistry();
    const xoIds = [...world.xos.keys()].sort();
    for (const xoId of xoIds) {
        for (const field of Object.keys(FIELD_RANGE)) {
            const range = FIELD_RANGE[field];
            registry.register({
                id: ruleId(xoId, field),
                appearsAt: range.appearsAt,
                fullyVisibleAt: range.fullyVisibleAt,
                data: { xoId, field, visibility: 0 },
            });
        }
    }
    return registry;
}
/** Every field's emergence state for one XO at a given altitude. */
export function emergenceForXO(registry, xoId, altitude) {
    return registry.at(altitude).filter((state) => state.data?.xoId === xoId);
}
/** Every (XO, field) pair currently emerged at all, most visible
 * first \u2014 useful for a consumer deciding what to render this frame
 * without iterating every XO in the world. */
export function visibleFields(registry, altitude) {
    return registry.visible(altitude);
}
function ruleId(xoId, field) {
    return `${xoId}::${field}`;
}
//# sourceMappingURL=semantic.js.map