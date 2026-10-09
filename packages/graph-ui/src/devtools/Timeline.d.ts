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
export declare class Timeline<T> {
    readonly entries: readonly TimelineEntry<T>[];
    private readonly limit;
    private constructor();
    static empty<T>(limit?: number): Timeline<T>;
    append(payload: T, timestampMs: number): Timeline<T>;
    clear(): Timeline<T>;
    get length(): number;
    /** Entries within [startMs, endMs], inclusive. */
    between(startMs: number, endMs: number): readonly TimelineEntry<T>[];
    get last(): TimelineEntry<T> | undefined;
}
export interface InteractionEventEntry {
    readonly name: string;
    readonly detail: unknown;
}
/** Timeline specialized for interaction events (name + arbitrary detail payload). */
export type EventTimeline = Timeline<InteractionEventEntry>;
export declare const EventTimeline: {
    empty: (limit?: number) => EventTimeline;
};
export interface CommandEntry {
    readonly name: string;
    readonly args: unknown;
}
/** Timeline specialized for executed commands (name + args payload). */
export type CommandTimeline = Timeline<CommandEntry>;
export declare const CommandTimeline: {
    empty: (limit?: number) => CommandTimeline;
};
//# sourceMappingURL=Timeline.d.ts.map