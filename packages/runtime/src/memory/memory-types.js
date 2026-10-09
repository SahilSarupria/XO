export const RUNTIME_MEMORY_GLOBAL_SCOPE_ID = 'global';
export function executionScope(executionId) {
    return Object.freeze({ kind: 'execution', scopeId: String(executionId) });
}
export function sessionScope(sessionId) {
    return Object.freeze({ kind: 'session', scopeId: String(sessionId) });
}
export function workflowScope(workflowInstanceId) {
    return Object.freeze({ kind: 'workflow', scopeId: String(workflowInstanceId) });
}
export function runtimeScope() {
    return Object.freeze({ kind: 'runtime', scopeId: RUNTIME_MEMORY_GLOBAL_SCOPE_ID });
}
export function scopeKey(scope) {
    return `${scope.kind}:${scope.scopeId}`;
}
export function scopesEqual(a, b) {
    return a.kind === b.kind && a.scopeId === b.scopeId;
}
//# sourceMappingURL=memory-types.js.map