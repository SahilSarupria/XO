/** INTERNAL vocabulary constants (re-exported by event.ts). Separate module so validate.ts has no import cycle with event.ts. */

export const AUDIT_EVENT_TYPES = [
  'access.attempted',
  'access.denied',
  'authorization.denied',
  'execution.attempted',
  'execution.denied',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.waiting_for_human',
  'workflow.attempted',
  'workflow.denied',
  'workflow.started',
  'workflow.resumed',
  'workflow.step.completed',
  'workflow.step.failed',
  'workflow.completed',
  'workflow.failed',
  'workflow.waiting_for_human',
  'humantask.attempted',
  'humantask.denied',
  'humantask.resolved',
  'humantask.failed',
  'audit.read',
  'audit.purged',
  // C0.3 — Environment Intelligence lifecycle (recorded through the canonical chained store).
  'environment.attempted',
  'environment.denied',
  'environment.completed',
  'environment.failed',
  'environment.cancelled',
  'environment.quarantined',
  'environment.revoked',
  'environment.purged',
] as const;

export const AUDIT_OUTCOMES = [
  'attempted',
  'allowed',
  'denied',
  'started',
  'completed',
  'failed',
  'cancelled',
  'quarantined',
  'revoked',
  'purged',
] as const;

export const AUDIT_TARGET_KINDS = [
  'workspace',
  'execution',
  'workflow',
  'workflow-execution',
  'workflow-step',
  'capability',
  'compilation',
  'source',
  'human-task',
  'audit-log',
] as const;

export const AUDIT_LIFECYCLE_PHASES = ['attempt', 'terminal', 'standalone'] as const;
