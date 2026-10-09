import { GraphSelection } from './GraphSelection.js';
/**
 * Immutable, named registry of saved selections — "save this selection as
 * a named preset, recall it later." Distinct from SelectionHistory (which
 * is chronological undo/redo); this is addressed by name.
 */
export declare class SavedSelections {
    private readonly byName;
    private constructor();
    static empty(): SavedSelections;
    save(name: string, selection: GraphSelection): SavedSelections;
    remove(name: string): SavedSelections;
    get(name: string): GraphSelection | undefined;
    has(name: string): boolean;
    get names(): readonly string[];
}
//# sourceMappingURL=SavedSelections.d.ts.map