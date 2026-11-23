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
  'idempotency.replayed',
  'idempotency.recovered',
  'idempotency.conflict',
  'idempotency.in_progress',
  'idempotency.indeterminate',
  'approval.attempted',
  'approval.granted',
  'approval.denied',
  // PX-2: a reviewer accepted (or was refused) the findings of a partial or degraded source version.
  'waiver.granted',
  'waiver.denied',
  // PX-3: a reviewer's ruling on a review item (a conflict, an unparsed sentence, a decision the compiler could not make).
  'ruling.recorded',
  'ruling.denied',
  // PX-4: governed changes to a workspace's Business Knowledge Base (proposed from a compilation, approved, rejected, or refused).
  'knowledge.change-set.proposed',
  'knowledge.change-set.approved',
  'knowledge.change-set.rejected',
  'knowledge.change-set.denied',
  'knowledge.pack.installed',
  // UW-5: a deterministic entity-resolution run (counts and hashes only).
  'resolution.computed',
  // UW-15: a run was refused before any effect because its data changed shape since it was compiled (counts only).
  'generated-workflow.drift.refused',
  // UW-8 (ADR 0046): a batch preview was prepared, approved, refused, or a start or call was refused against it (counts and ids only).
  'generated-workflow.batch.previewed',
  'generated-workflow.batch.approved',
  'generated-workflow.batch.refused',
  'generated-workflow.batch.required',
  'generated-workflow.batch.revoked',
  // UW-12b (ADR 0052): a waiting step was delegated to another reviewer; a reviewer asked for changes to a batch preview (ids only).
  'generated-workflow.approval.delegated',
  'generated-workflow.batch.changes-requested',
  // UW-16 (ADR 0051): a standing approval was proposed, approved, refused, returned for changes, revoked, used, or fell back to a batch approval
  // (ids, counts, reason codes and booleans only).
  // UW-11b: a person recorded a correction to a run (ids and counts only; never the field or value).
  'run-learning.correction-recorded',
  'standing-approval.proposed',
  'standing-approval.approved',
  'standing-approval.refused',
  'standing-approval.changes-requested',
  'standing-approval.revoked',
  'standing-approval.used',
  'standing-approval.fallback',
  // RX-1a (ADR 0048): an emergency stop was engaged or released (scope and target), or held a start.
  'emergency-stop.engaged',
  'emergency-stop.released',
  'emergency-stop.refused',
  // RX-1b (ADR 0048): a signed audit bundle of a run was exported (run id and counts only).
  'generated-workflow.audit-bundle.exported',
  // UW-6: free text was turned into a structured proposal by a model and composed (counts and digests only).
  'intent.proposed',
  // UW-10c: the workspace's explicit email recipient rules were replaced (counts only).
  'email.recipient-rules.updated',
  // PX-7: a readiness certificate was issued, or a start was refused at the certificate gate.
  'readiness.certificate.issued',
  'readiness.start.refused',
  // ADR 0030: generated workflows run as Workflow IR; connector bindings are the operator's statement of effects.
  'generated-workflow.run.started',
  'generated-workflow.approval.decided',
  'connector-bindings.updated',
  // ADR 0031: a connector call refused at the side-effect boundary (permission, pause, binding or approval changed).
  'generated-workflow.effect.denied',
  // UW-2 (ADR 0032): the Workflow entity — created (from a conversation or the API), a new version, and every other change
  // (rename, pause, resume, archive, restore; the change is in metadata.event).
  // UW-7 (ADR 0024, ADR 0033): a run (or batch) cancel request, applied now or by the run's driver; a person's record of what
  // happened to a call whose outcome was unknown.
  'generated-workflow.run.cancelled',
  'generated-workflow.effect.reconciled',
  // UW-9: connection credentials (never carries a secret, an account id or an account label; accountRef is a hash).
  'credential.oauth.started',
  'credential.oauth.failed',
  'credential.created',
  'credential.refreshed',
  'credential.refresh_failed',
  'credential.rotated',
  'credential.revoked',
  'credential.use_denied',
  // UW-14e (ADR 0037): the leak guard refused a model request carrying a protected value (metadata: hashes, never a value); a
  // workspace's data-protection settings changed (counts only).
  'model.egress.blocked',
  'data-protection.updated',
  'workflow-entity.created',
  'workflow-entity.version.added',
  'workflow-entity.updated',
  'audit.read',
  'audit.purged',
  // P1.1 M2 — owner-approved bounded subset (2026-10-18). Execution-detail and step-level procedure events are NOT part of it.
  'procedure.authored',
  'procedure.validated',
  'procedure.approval.granted',
  'procedure.approval.denied',
  'procedure.attempted',
  'procedure.denied',
  // P1.1 M3 — owner-approved execution subset (2026-10-18): exactly these seven. No cancel/retry/effect/MCP types.
  'procedure.execution.started',
  'procedure.execution.waiting_for_human',
  'procedure.execution.resumed',
  'procedure.execution.completed',
  'procedure.execution.failed',
  'procedure.step.completed',
  'procedure.step.failed',
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
  'procedure',
  'procedure-execution',
  'procedure-step',
  // PX-4: a proposed change to a workspace's Business Knowledge Base, or an installed Domain Knowledge Pack.
  'knowledge-change-set',
  'knowledge-pack',
  // UW-2: a durable Workflow entity (`wfl_…`).
  'workflow-entity',
  'credential',
  // UW-16 (ADR 0051): a standing approval (`sap_…`).
  'standing-approval',
] as const;

export const AUDIT_LIFECYCLE_PHASES = ['attempt', 'terminal', 'standalone'] as const;
