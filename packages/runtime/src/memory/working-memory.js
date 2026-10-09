const DEFAULT_MAX_TURNS_PER_SESSION = 20;
/**
 * **Working memory only** — an in-process, per-`SessionId` turn history
 * with a bounded size, never persisted to any store and never shared
 * across sessions. This is deliberately *not* long-term memory, shared
 * memory, learning, or Experience Graph mutation (all explicit Stage 2
 * non-goals): nothing here ever reads from or writes to a mounted
 * package's own knowledge components, nothing outlives the process, and
 * there is no cross-session or cross-user visibility of any kind. A
 * later runtime stage that adds real long-term/shared memory is a
 * distinct component, not an extension of this one.
 */
export class MemoryManager {
    maxTurnsPerSession;
    bySession = new Map();
    constructor(maxTurnsPerSession = DEFAULT_MAX_TURNS_PER_SESSION) {
        this.maxTurnsPerSession = maxTurnsPerSession;
    }
    /** Appends a turn, trimming the oldest turns first once `maxTurnsPerSession` is exceeded. */
    append(sessionId, turn) {
        const existing = this.bySession.get(sessionId) ?? [];
        const next = [...existing, turn].slice(-this.maxTurnsPerSession);
        this.bySession.set(sessionId, next);
    }
    /** Every turn recorded for `sessionId`, oldest first. Empty (never throws) if nothing was ever recorded. */
    get(sessionId) {
        return this.bySession.get(sessionId) ?? [];
    }
    clear(sessionId) {
        this.bySession.delete(sessionId);
    }
    get sessionCount() {
        return this.bySession.size;
    }
}
//# sourceMappingURL=working-memory.js.map