import { createSession } from './execution-session.js';
/**
 * The stateful counterpart to Stage 1's pure `createSession`/`withPlan`/
 * `withReceipt`/... functions — the same functional-core/imperative-shell
 * split `Runtime` (Stage 1) uses for `PackageRegistry`. Every session
 * value stored here is still the same immutable `ExecutionSession`
 * produced by those pure functions; this class only holds "the current
 * one per id" and swaps it on `update`.
 */
export class SessionManager {
    now;
    sessions = new Map();
    constructor(now = () => new Date()) {
        this.now = now;
    }
    create(request) {
        const session = createSession(request, this.now);
        this.sessions.set(session.sessionId, session);
        return session;
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Stores `session` as the current value for its own `sessionId`, overwriting whatever was there before. Returns `session` unchanged, for convenient chaining at call sites. */
    update(session) {
        this.sessions.set(session.sessionId, session);
        return session;
    }
    all() {
        return [...this.sessions.values()];
    }
    delete(sessionId) {
        return this.sessions.delete(sessionId);
    }
    get size() {
        return this.sessions.size;
    }
}
//# sourceMappingURL=session-manager.js.map