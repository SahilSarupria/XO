import { isAuthenticatedPrincipal, type AuthorizationSubject } from '@xo/permissions';
import { AuditError, ErrorCode } from '@xo/errors';
import { SYSTEM_ACTOR, actorFromPrincipal, type AuditActor, type AuditEventDraft } from './event.js';
import { isDurableReceipt } from './receipt.js';
import type { AuditSink } from './sink.js';

/** Structurally identical to `@xo/runtime`'s `RuntimeExecutionAudit` (which deliberately has no dependency on this package). */
export interface RuntimeExecutionAuditPort {
  beforeExecute(info: {
    readonly capabilityId: string;
    readonly requesterPackageId: string;
    readonly subject: AuthorizationSubject;
  }): Promise<void>;
  onDenied(info: {
    readonly capabilityId: string;
    readonly requesterPackageId: string;
    readonly subject: AuthorizationSubject;
    readonly reasonCode: string;
  }): Promise<void>;
  afterExecute(info: {
    readonly capabilityId: string;
    readonly requesterPackageId: string;
    readonly subject: AuthorizationSubject;
    readonly ok: boolean;
    readonly reasonCode?: string;
  }): Promise<boolean>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function actorFor(subject: AuthorizationSubject): AuditActor {
  if (isAuthenticatedPrincipal(subject)) return actorFromPrincipal(subject);
  // A TrustedExecutionContext (local CLI operator) is NOT an identity — recorded as the system actor, never as a person.
  return SYSTEM_ACTOR;
}

/**
 * Adapter for DIRECT runtime execution (CLI `xo run` / `xo workflow`, embedders). Wire it into
 * `RuntimeCapabilityExecutor` / `executeResolvedContract` via their `audit` option. One correlation id per adapter
 * instance ties a run's events together.
 */
export function createRuntimeExecutionAudit(sink: AuditSink, correlationId: string): RuntimeExecutionAuditPort {
  const base = (i: { capabilityId: string; requesterPackageId: string; subject: AuthorizationSubject }) => ({
    action: 'execute.capability',
    actor: actorFor(i.subject),
    correlationId,
    ...(ID_RE.test(i.capabilityId) ? { target: { kind: 'capability' as const, id: i.capabilityId } } : {}),
  });
  const confirm = async (draft: AuditEventDraft): Promise<boolean> => {
    try {
      const r = await sink.append(draft);
      return r.ok && isDurableReceipt(r.receipt) && (r.receipt.guarantee === 'fsync-file' || sink.mode === 'non-production');
    } catch {
      return false;
    }
  };
  return {
    async beforeExecute(info) {
      if (!(await confirm({ ...base(info), type: 'execution.started', outcome: 'started' }))) {
        throw new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'required audit evidence could not be durably recorded');
      }
    },
    async onDenied(info) {
      await confirm({
        ...base(info),
        type: 'execution.denied',
        outcome: 'denied',
        reasonCode: ID_RE.test(info.reasonCode) ? info.reasonCode : ErrorCode.UNKNOWN,
      });
    },
    async afterExecute(info) {
      return confirm({
        ...base(info),
        type: info.ok ? 'execution.completed' : 'execution.failed',
        outcome: info.ok ? 'completed' : 'failed',
        ...(!info.ok && info.reasonCode !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(info.reasonCode)
          ? { reasonCode: info.reasonCode }
          : {}),
      });
    },
  };
}
