import type { WorkflowInstance } from './workflow-instance.js';
import { WorkflowCheckpointId, type WorkflowInstanceId } from '../ids.js';

/**
 * A self-contained, in-memory-only snapshot of a suspended
 * `WorkflowInstance` — "do NOT implement persistence yet" per the Stage
 * 3 brief. Carries the full `graph` (not just `state`) so `resume()`
 * never needs the caller to re-supply it; the checkpoint alone is
 * everything `WorkflowExecutor.resume` needs.
 */
export interface WorkflowCheckpoint {
  readonly checkpointId: WorkflowCheckpointId;
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly instance: WorkflowInstance;
  readonly createdAt: string;
}

// A module-scoped monotonic counter, not wall-clock time alone, is what
// actually guarantees checkpoint id uniqueness — two checkpoints for the
// same execution created within the same millisecond (entirely possible:
// nothing stops two rounds of a fast, unthrottled workflow from
// completing inside one JS event-loop tick, as Stage 4's own tests
// found) would otherwise collide and silently overwrite each other in a
// `Map`/file keyed by checkpoint id. A plain incrementing counter, not
// randomness — deterministic for a given sequence of calls.
let checkpointSequenceCounter = 0;
function nextCheckpointSequence(): number {
  checkpointSequenceCounter += 1;
  return checkpointSequenceCounter;
}

export function createCheckpoint(instance: WorkflowInstance, now: () => Date = () => new Date()): WorkflowCheckpoint {
  return Object.freeze({
    checkpointId: WorkflowCheckpointId(`checkpoint_${instance.workflowInstanceId}_${now().getTime()}_${nextCheckpointSequence()}`),
    workflowInstanceId: instance.workflowInstanceId,
    instance,
    createdAt: now().toISOString(),
  });
}

/**
 * The stateful, `Map`-based counterpart to the pure `createCheckpoint`
 * above — the same functional-core/imperative-shell split as
 * `SessionManager` (Stage 2) and `PackageRegistry`/`Runtime` (Stage 1).
 * In-memory only: nothing here is written to any `BlobStore` or other
 * durable storage. A future stage adding real persistence would wrap or
 * replace this class, not `createCheckpoint` itself.
 */
export class CheckpointStore {
  private readonly checkpoints = new Map<string, WorkflowCheckpoint>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(instance: WorkflowInstance): WorkflowCheckpoint {
    const checkpoint = createCheckpoint(instance, this.now);
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    return checkpoint;
  }

  get(checkpointId: WorkflowCheckpointId): WorkflowCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  delete(checkpointId: WorkflowCheckpointId): boolean {
    return this.checkpoints.delete(checkpointId);
  }

  /** Every checkpoint ever created for `workflowInstanceId`, oldest first (insertion order — `Map` iteration order is used here deliberately and safely, since checkpoints are only ever appended, never reordered or removed except by explicit `delete`). */
  forInstance(workflowInstanceId: WorkflowInstanceId): readonly WorkflowCheckpoint[] {
    return [...this.checkpoints.values()].filter((checkpoint) => checkpoint.workflowInstanceId === workflowInstanceId);
  }
}
