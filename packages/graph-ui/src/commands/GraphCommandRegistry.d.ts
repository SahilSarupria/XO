import type { GroupId, NodeId } from '../model/types.js';
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
/**
 * Registry of generic, controller-driven graph commands. Ships with the ten
 * built-ins (`zoomIn`, `zoomOut`, `fit`, `center`, `search`, `highlight`,
 * `expand`, `collapse`, `selectAll`, `clearSelection`); register more with
 * `registry.register(name, handler)`. Every built-in is implemented purely
 * in terms of GraphController's already-public API — commands never reach
 * past the controller into model/viewport/selection internals directly.
 */
export declare class GraphCommandRegistry {
    private readonly handlers;
    constructor();
    register<TArgs = void>(name: string, handler: GraphCommandHandler<TArgs>): this;
    has(name: string): boolean;
    get availableCommands(): readonly string[];
    execute<TArgs = void>(name: string, context: GraphCommandContext, args?: TArgs): void;
}
export { BUILTIN_COMMAND_NAMES };
export type { BuiltinCommandName } from './types.js';
//# sourceMappingURL=GraphCommandRegistry.d.ts.map