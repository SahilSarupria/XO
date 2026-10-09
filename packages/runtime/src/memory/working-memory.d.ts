import type { SessionId } from '../ids.js';
export type WorkingMemoryRole = 'user' | 'assistant';
export interface WorkingMemoryTurn {
    readonly role: WorkingMemoryRole;
    readonly content: string;
    readonly recordedAt: string;
}
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
export declare class MemoryManager {
    private readonly maxTurnsPerSession;
    private readonly bySession;
    constructor(maxTurnsPerSession?: number);
    /** Appends a turn, trimming the oldest turns first once `maxTurnsPerSession` is exceeded. */
    append(sessionId: SessionId, turn: WorkingMemoryTurn): void;
    /** Every turn recorded for `sessionId`, oldest first. Empty (never throws) if nothing was ever recorded. */
    get(sessionId: SessionId): readonly WorkingMemoryTurn[];
    clear(sessionId: SessionId): void;
    get sessionCount(): number;
}
//# sourceMappingURL=working-memory.d.ts.map