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
export declare function createCheckpoint(instance: WorkflowInstance, now?: () => Date): WorkflowCheckpoint;
/**
 * The stateful, `Map`-based counterpart to the pure `createCheckpoint`
 * above — the same functional-core/imperative-shell split as
 * `SessionManager` (Stage 2) and `PackageRegistry`/`Runtime` (Stage 1).
 * In-memory only: nothing here is written to any `BlobStore` or other
 * durable storage. A future stage adding real persistence would wrap or
 * replace this class, not `createCheckpoint` itself.
 */
export declare class CheckpointStore {
    private readonly now;
    private readonly checkpoints;
    constructor(now?: () => Date);
    create(instance: WorkflowInstance): WorkflowCheckpoint;
    get(checkpointId: WorkflowCheckpointId): WorkflowCheckpoint | undefined;
    delete(checkpointId: WorkflowCheckpointId): boolean;
    /** Every checkpoint ever created for `workflowInstanceId`, oldest first (insertion order — `Map` iteration order is used here deliberately and safely, since checkpoints are only ever appended, never reordered or removed except by explicit `delete`). */
    forInstance(workflowInstanceId: WorkflowInstanceId): readonly WorkflowCheckpoint[];
}
//# sourceMappingURL=workflow-checkpoint.d.ts.map