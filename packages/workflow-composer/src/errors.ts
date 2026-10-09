/**
 * This package deliberately does not depend on `@xo/errors` (an
 * unrelated package to this task's scope) — composition failures here
 * are all programmer-input errors (an id that isn't in the supplied
 * graph), not domain errors the rest of the platform needs a shared
 * `ErrorCode` for. A small local, `Result`-carried error type is enough.
 */
export type WorkflowCompositionErrorCode = 'CAPABILITY_NODE_NOT_FOUND' | 'NODE_NOT_A_CAPABILITY';

export class WorkflowCompositionError extends Error {
  public readonly code: WorkflowCompositionErrorCode;
  public readonly context: Readonly<Record<string, unknown>>;

  constructor(code: WorkflowCompositionErrorCode, message: string, context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'WorkflowCompositionError';
    this.code = code;
    this.context = context;
  }
}
