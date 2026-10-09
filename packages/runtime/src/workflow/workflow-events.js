/**
 * A small synchronous fan-out emitter — deliberately not async/awaited
 * (mirrors `ExecutionHooks`' "a throwing hook never fails the execution
 * it's observing" principle from Stage 2): a listener that throws is
 * caught and never propagates into `WorkflowExecutor`'s own control
 * flow. Distinct from `RuntimeInstrumentation`'s OTel-style
 * counters/histograms (which Stage 3 also emits into, additively — see
 * `observability/instrumentation.ts`); this is the workflow-specific,
 * structured event stream a caller can subscribe to directly.
 */
export class WorkflowEventEmitter {
    listeners = [];
    on(listener) {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0)
                this.listeners.splice(index, 1);
        };
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch {
                // a listener's own failure must never affect workflow execution
            }
        }
    }
}
//# sourceMappingURL=workflow-events.js.map