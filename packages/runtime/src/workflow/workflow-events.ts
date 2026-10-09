import type { NodeId } from './workflow-graph.js';
import type { WorkflowInstanceId } from '../ids.js';

export type WorkflowEventType = 'started' | 'completed' | 'failed' | 'cancelled' | 'checkpoint' | 'resumed' | 'node_started' | 'node_completed' | 'node_failed';

export interface WorkflowEvent {
  readonly type: WorkflowEventType;
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly nodeId?: NodeId;
  readonly timestamp: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type WorkflowEventListener = (event: WorkflowEvent) => void;

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
  private readonly listeners: WorkflowEventListener[] = [];

  on(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a listener's own failure must never affect workflow execution
      }
    }
  }
}
