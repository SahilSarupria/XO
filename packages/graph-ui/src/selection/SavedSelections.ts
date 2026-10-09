import { GraphSelection } from './GraphSelection.js';

/**
 * Immutable, named registry of saved selections — "save this selection as
 * a named preset, recall it later." Distinct from SelectionHistory (which
 * is chronological undo/redo); this is addressed by name.
 */
export class SavedSelections {
  private constructor(private readonly byName: ReadonlyMap<string, GraphSelection>) {}

  static empty(): SavedSelections {
    return new SavedSelections(new Map());
  }

  save(name: string, selection: GraphSelection): SavedSelections {
    const next = new Map(this.byName);
    next.set(name, selection);
    return new SavedSelections(next);
  }

  remove(name: string): SavedSelections {
    if (!this.byName.has(name)) return this;
    const next = new Map(this.byName);
    next.delete(name);
    return new SavedSelections(next);
  }

  get(name: string): GraphSelection | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get names(): readonly string[] {
    return [...this.byName.keys()];
  }
}
