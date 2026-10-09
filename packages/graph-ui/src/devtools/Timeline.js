/**
 * Append-only, immutable, capped log — the shared shape behind both
 * EventTimeline and CommandTimeline. `append` returns a new instance;
 * nothing is ever mutated in place, and the oldest entries fall off once
 * `limit` is exceeded (same capping behavior as HistoryStack).
 */
export class Timeline {
    entries;
    limit;
    constructor(entries, limit) {
        this.entries = entries;
        this.limit = limit;
    }
    static empty(limit = 1000) {
        return new Timeline([], limit);
    }
    append(payload, timestampMs) {
        const next = [...this.entries, { timestampMs, payload }].slice(-this.limit);
        return new Timeline(next, this.limit);
    }
    clear() {
        return new Timeline([], this.limit);
    }
    get length() {
        return this.entries.length;
    }
    /** Entries within [startMs, endMs], inclusive. */
    between(startMs, endMs) {
        return this.entries.filter((e) => e.timestampMs >= startMs && e.timestampMs <= endMs);
    }
    get last() {
        return this.entries[this.entries.length - 1];
    }
}
export const EventTimeline = {
    empty: (limit = 1000) => Timeline.empty(limit),
};
export const CommandTimeline = {
    empty: (limit = 1000) => Timeline.empty(limit),
};
//# sourceMappingURL=Timeline.js.map