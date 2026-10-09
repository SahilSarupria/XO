import { BUILTIN_COMMAND_NAMES } from './types.js';
function requireViewportSize(context) {
    if (!context.viewportSize)
        throw new Error('This command requires a viewportSize in the command context.');
    return context.viewportSize;
}
function currentCollapsedGroups(controller) {
    return new Set(controller.getState().filters.state.collapsedGroupIds ?? []);
}
/**
 * Registry of generic, controller-driven graph commands. Ships with the ten
 * built-ins (`zoomIn`, `zoomOut`, `fit`, `center`, `search`, `highlight`,
 * `expand`, `collapse`, `selectAll`, `clearSelection`); register more with
 * `registry.register(name, handler)`. Every built-in is implemented purely
 * in terms of GraphController's already-public API — commands never reach
 * past the controller into model/viewport/selection internals directly.
 */
export class GraphCommandRegistry {
    handlers = new Map();
    constructor() {
        this.register('zoomIn', (ctx, args = {}) => ctx.controller.zoomBy(args.factor ?? 1.2));
        this.register('zoomOut', (ctx, args = {}) => ctx.controller.zoomBy(1 / (args.factor ?? 1.2)));
        this.register('fit', (ctx) => ctx.controller.fitToScreen(requireViewportSize(ctx)));
        this.register('center', (ctx, args) => ctx.controller.centerNode(args.nodeId, requireViewportSize(ctx)));
        this.register('search', (ctx, args) => ctx.controller.search(args.query));
        this.register('highlight', (ctx, args) => {
            ctx.controller.clearSelection();
            args.nodeIds.forEach((id, i) => ctx.controller.selectNode(id, { additive: i > 0 }));
        });
        this.register('expand', (ctx, args) => {
            const collapsed = currentCollapsedGroups(ctx.controller);
            collapsed.delete(args.groupId);
            ctx.controller.updateFilters((f) => f.withCollapsedGroups([...collapsed]));
        });
        this.register('collapse', (ctx, args) => {
            const collapsed = currentCollapsedGroups(ctx.controller);
            collapsed.add(args.groupId);
            ctx.controller.updateFilters((f) => f.withCollapsedGroups([...collapsed]));
        });
        this.register('selectAll', (ctx) => {
            const ids = ctx.controller.visibleModel.nodes.map((n) => n.id);
            ctx.controller.clearSelection();
            ids.forEach((id, i) => ctx.controller.selectNode(id, { additive: i > 0 }));
        });
        this.register('clearSelection', (ctx) => ctx.controller.clearSelection());
    }
    register(name, handler) {
        this.handlers.set(name, handler);
        return this;
    }
    has(name) {
        return this.handlers.has(name);
    }
    get availableCommands() {
        return [...this.handlers.keys()];
    }
    execute(name, context, args) {
        const handler = this.handlers.get(name);
        if (!handler) {
            throw new Error(`Unknown command: "${name}". Registered commands: ${this.availableCommands.join(', ')}`);
        }
        handler(context, args);
    }
}
export { BUILTIN_COMMAND_NAMES };
//# sourceMappingURL=GraphCommandRegistry.js.map