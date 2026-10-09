import type { GraphController } from '../controller/GraphController.js';
import type { GroupId, NodeId, Size } from '../model/types.js';
import { BUILTIN_COMMAND_NAMES, type GraphCommandContext, type GraphCommandHandler } from './types.js';

export interface ZoomArgs {
  readonly factor?: number;
}

export interface CenterArgs {
  readonly nodeId: NodeId;
}

export interface SearchArgs {
  readonly query: string;
}

export interface HighlightArgs {
  readonly nodeIds: readonly NodeId[];
}

export interface GroupArgs {
  readonly groupId: GroupId;
}

function requireViewportSize(context: GraphCommandContext): Size {
  if (!context.viewportSize) throw new Error('This command requires a viewportSize in the command context.');
  return context.viewportSize;
}

function currentCollapsedGroups(controller: GraphController): Set<GroupId> {
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
  private readonly handlers = new Map<string, GraphCommandHandler<any>>();

  constructor() {
    this.register('zoomIn', (ctx, args: ZoomArgs = {}) => ctx.controller.zoomBy(args.factor ?? 1.2));
    this.register('zoomOut', (ctx, args: ZoomArgs = {}) => ctx.controller.zoomBy(1 / (args.factor ?? 1.2)));
    this.register('fit', (ctx) => ctx.controller.fitToScreen(requireViewportSize(ctx)));
    this.register('center', (ctx, args: CenterArgs) => ctx.controller.centerNode(args.nodeId, requireViewportSize(ctx)));
    this.register('search', (ctx, args: SearchArgs) => ctx.controller.search(args.query));
    this.register('highlight', (ctx, args: HighlightArgs) => {
      ctx.controller.clearSelection();
      args.nodeIds.forEach((id, i) => ctx.controller.selectNode(id, { additive: i > 0 }));
    });
    this.register('expand', (ctx, args: GroupArgs) => {
      const collapsed = currentCollapsedGroups(ctx.controller);
      collapsed.delete(args.groupId);
      ctx.controller.updateFilters((f) => f.withCollapsedGroups([...collapsed]));
    });
    this.register('collapse', (ctx, args: GroupArgs) => {
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

  register<TArgs = void>(name: string, handler: GraphCommandHandler<TArgs>): this {
    this.handlers.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get availableCommands(): readonly string[] {
    return [...this.handlers.keys()];
  }

  execute<TArgs = void>(name: string, context: GraphCommandContext, args?: TArgs): void {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Unknown command: "${name}". Registered commands: ${this.availableCommands.join(', ')}`);
    }
    handler(context, args as TArgs);
  }
}

export { BUILTIN_COMMAND_NAMES };
export type { BuiltinCommandName } from './types.js';
