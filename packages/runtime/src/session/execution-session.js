import { SessionId } from '../ids.js';
export function createSession(request, now = () => new Date()) {
    const environment = request.environment;
    const timestamp = now().toISOString();
    return Object.freeze({
        sessionId: SessionId(`session_${request.requestId}`),
        requestId: request.requestId,
        mountedPackages: [],
        chosenCapabilities: [],
        ...(environment.tokenBudget !== undefined ? { tokenBudget: environment.tokenBudget } : {}),
        ...(environment.provider !== undefined ? { provider: environment.provider } : {}),
        status: 'pending',
        receipts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    });
}
/** Records a plan's outcome onto the session: `planned` (with the selected package/capability) if the plan found a compatible candidate, `plan_failed` otherwise. */
export function withPlan(session, plan, now = () => new Date()) {
    const selected = plan.selected;
    return Object.freeze({
        ...session,
        mountedPackages: selected ? [{ name: selected.capability.packageName, version: selected.capability.packageVersion }] : session.mountedPackages,
        chosenCapabilities: selected ? [selected.capability.declaration.id] : session.chosenCapabilities,
        status: (selected ? 'planned' : 'plan_failed'),
        updatedAt: now().toISOString(),
    });
}
export function withReceipt(session, receipt, now = () => new Date(), options = {}) {
    return Object.freeze({
        ...session,
        receipts: [...session.receipts, receipt],
        status: 'completed',
        updatedAt: now().toISOString(),
        ...(options.degraded !== undefined ? { degraded: options.degraded } : {}),
    });
}
// --- Stage 2 transitions -----------------------------------------------
// `createSession`/`withPlan`/`withReceipt` above are unmodified in
// behavior for every argument list Stage 1 ever passed them (`withReceipt`
// only gained a new *optional* fourth parameter). Everything below is new.
/** Marks a planned session as actively running the AI Capability Layer call — the gap between `withPlan` and `withReceipt`/`withCancelled`/`withTimedOut`/`withFailed`. */
export function withExecuting(session, now = () => new Date()) {
    return Object.freeze({ ...session, status: 'executing', updatedAt: now().toISOString() });
}
export function withCancelled(session, now = () => new Date()) {
    return Object.freeze({ ...session, status: 'cancelled', updatedAt: now().toISOString() });
}
export function withTimedOut(session, now = () => new Date()) {
    return Object.freeze({ ...session, status: 'timed_out', updatedAt: now().toISOString() });
}
export function withFailed(session, now = () => new Date()) {
    return Object.freeze({ ...session, status: 'failed', updatedAt: now().toISOString() });
}
//# sourceMappingURL=execution-session.js.map