export interface TimelineEntry<T> {
  readonly timestampMs: number;
  readonly payload: T;
}

/**
 * Append-only, immutable, capped log — the shared shape behind both
 * EventTimeline and CommandTimeline. `append` returns a new instance;
 * nothing is ever mutated in place, and the oldest entries fall off once
 * `limit` is exceeded (same capping behavior as HistoryStack).
 */
export class Timeline<T> {
  private constructor(readonly entries: readonly TimelineEntry<T>[], private readonly limit: number) {}

  static empty<T>(limit = 1000): Timeline<T> {
    return new Timeline<T>([], limit);
  }

  append(payload: T, timestampMs: number): Timeline<T> {
    const next = [...this.entries, { timestampMs, payload }].slice(-this.limit);
    return new Timeline<T>(next, this.limit);
  }

  clear(): Timeline<T> {
    return new Timeline<T>([], this.limit);
  }

  get length(): number {
    return this.entries.length;
  }

  /** Entries within [startMs, endMs], inclusive. */
  between(startMs: number, endMs: number): readonly TimelineEntry<T>[] {
    return this.entries.filter((e) => e.timestampMs >= startMs && e.timestampMs <= endMs);
  }

  get last(): TimelineEntry<T> | undefined {
    return this.entries[this.entries.length - 1];
  }
}

export interface InteractionEventEntry {
  readonly name: string;
  readonly detail: unknown;
}

/** Timeline specialized for interaction events (name + arbitrary detail payload). */
export type EventTimeline = Timeline<InteractionEventEntry>;
export const EventTimeline = {
  empty: (limit = 1000): EventTimeline => Timeline.empty<InteractionEventEntry>(limit),
};

export interface CommandEntry {
  readonly name: string;
  readonly args: unknown;
}

/** Timeline specialized for executed commands (name + args payload). */
export type CommandTimeline = Timeline<CommandEntry>;
export const CommandTimeline = {
  empty: (limit = 1000): CommandTimeline => Timeline.empty<CommandEntry>(limit),
};
