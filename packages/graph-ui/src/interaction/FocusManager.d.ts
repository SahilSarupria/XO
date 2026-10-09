import type { GraphModel } from '../model/GraphModel.js';
import type { NodeId } from '../model/types.js';
import { type KeyboardDirection } from './GraphInteraction.js';
export interface FocusState {
    readonly focusedNodeId?: NodeId;
}
/**
 * Deterministic keyboard-focus tracker for accessibility navigation: which
 * single node currently "has focus" (analogous to DOM focus, but with zero
 * DOM dependency), plus a stable tab order derived from the model.
 */
export declare class FocusManager {
    readonly state: FocusState;
    private constructor();
    static none(): FocusManager;
    focus(nodeId: NodeId): FocusManager;
    blur(): FocusManager;
    get isFocused(): boolean;
    /** Stable accessibility tab order: the model's deterministic insertion order. */
    static tabOrder(model: GraphModel): readonly NodeId[];
    /** Moves focus to the next/previous node in tab order, wrapping at both ends. */
    focusNext(model: GraphModel, reverse?: boolean): FocusManager;
    /** Moves focus spatially (arrow-key navigation), reusing GraphInteraction's directional search. Stays put if there's no neighbor in that direction. */
    focusDirectional(model: GraphModel, direction: KeyboardDirection): FocusManager;
}
//# sourceMappingURL=FocusManager.d.ts.map