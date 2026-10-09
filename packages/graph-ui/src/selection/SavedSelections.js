/**
 * Immutable, named registry of saved selections — "save this selection as
 * a named preset, recall it later." Distinct from SelectionHistory (which
 * is chronological undo/redo); this is addressed by name.
 */
export class SavedSelections {
    byName;
    constructor(byName) {
        this.byName = byName;
    }
    static empty() {
        return new SavedSelections(new Map());
    }
    save(name, selection) {
        const next = new Map(this.byName);
        next.set(name, selection);
        return new SavedSelections(next);
    }
    remove(name) {
        if (!this.byName.has(name))
            return this;
        const next = new Map(this.byName);
        next.delete(name);
        return new SavedSelections(next);
    }
    get(name) {
        return this.byName.get(name);
    }
    has(name) {
        return this.byName.has(name);
    }
    get names() {
        return [...this.byName.keys()];
    }
}
//# sourceMappingURL=SavedSelections.js.map