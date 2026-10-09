import type { ExecutionRequest } from '../execution/execution-request.js';
import type { SessionId } from '../ids.js';
import { type ExecutionSession } from './execution-session.js';
/**
 * The stateful counterpart to Stage 1's pure `createSession`/`withPlan`/
 * `withReceipt`/... functions — the same functional-core/imperative-shell
 * split `Runtime` (Stage 1) uses for `PackageRegistry`. Every session
 * value stored here is still the same immutable `ExecutionSession`
 * produced by those pure functions; this class only holds "the current
 * one per id" and swaps it on `update`.
 */
export declare class SessionManager {
    private readonly now;
    private readonly sessions;
    constructor(now?: () => Date);
    create(request: ExecutionRequest): ExecutionSession;
    get(sessionId: SessionId): ExecutionSession | undefined;
    /** Stores `session` as the current value for its own `sessionId`, overwriting whatever was there before. Returns `session` unchanged, for convenient chaining at call sites. */
    update(session: ExecutionSession): ExecutionSession;
    all(): readonly ExecutionSession[];
    delete(sessionId: SessionId): boolean;
    get size(): number;
}
//# sourceMappingURL=session-manager.d.ts.map