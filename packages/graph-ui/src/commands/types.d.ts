import type { GraphController } from '../controller/GraphController.js';
import type { Size } from '../model/types.js';
/** Context every command handler executes against. */
export interface GraphCommandContext {
    readonly controller: GraphController;
    readonly viewportSize?: Size;
}
export type GraphCommandHandler<TArgs = void> = (context: GraphCommandContext, args: TArgs) => void;
export declare const BUILTIN_COMMAND_NAMES: readonly ["zoomIn", "zoomOut", "fit", "center", "search", "highlight", "expand", "collapse", "selectAll", "clearSelection"];
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];
//# sourceMappingURL=types.d.ts.map