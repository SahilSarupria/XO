import type { ExecutionRequest } from '../execution/execution-request.js';
import type { SessionId } from '../ids.js';
import { createSession, type ExecutionSession } from './execution-session.js';

/**
 * The stateful counterpart to Stage 1's pure `createSession`/`withPlan`/
 * `withReceipt`/... functions — the same functional-core/imperative-shell
 * split `Runtime` (Stage 1) uses for `PackageRegistry`. Every session
 * value stored here is still the same immutable `ExecutionSession`
 * produced by those pure functions; this class only holds "the current
 * one per id" and swaps it on `update`.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ExecutionSession>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(request: ExecutionRequest): ExecutionSession {
    const session = createSession(request, this.now);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: SessionId): ExecutionSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Stores `session` as the current value for its own `sessionId`, overwriting whatever was there before. Returns `session` unchanged, for convenient chaining at call sites. */
  update(session: ExecutionSession): ExecutionSession {
    this.sessions.set(session.sessionId, session);
    return session;
  }

  all(): readonly ExecutionSession[] {
    return [...this.sessions.values()];
  }

  delete(sessionId: SessionId): boolean {
    return this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}
