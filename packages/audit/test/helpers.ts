import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  establishAuthenticatedPrincipal,
  Permissions,
  PermissionManager,
  RuleBasedPolicy,
  type AuthenticatedPrincipal,
} from '@xo/permissions';
import { actorFromPrincipal, AuditAccessController, type AuditEventDraft } from '../src/index.js';

export async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'xo-audit-'));
}
export function principal(kind: 'human' | 'service', id: string): AuthenticatedPrincipal {
  const r = establishAuthenticatedPrincipal({ kind, id });
  if (!r.ok) throw r.error;
  return r.value;
}
export function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    type: 'access.attempted',
    action: 'read.execution',
    outcome: 'attempted',
    actor: actorFromPrincipal(principal('human', 'alice')),
    target: { kind: 'execution', id: 'exec-1', workspaceId: 'ws-1' },
    correlationId: 'corr-1',
    ...overrides,
  };
}
/** A controller whose policy allows audit.read/audit.purge for service principals only (service 'auditor'). */
export function controller(opts: { allow?: boolean; kinds?: ('human' | 'service')[]; revoked?: Set<string> } = {}): AuditAccessController {
  const rules =
    opts.allow === false
      ? []
      : [
          { id: 'allow-audit-read', effect: 'ALLOW' as const, match: { permission: Permissions.audit.read, principalId: 'auditor' } },
          { id: 'allow-audit-purge', effect: 'ALLOW' as const, match: { permission: Permissions.audit.purge, principalId: 'auditor' } },
          { id: 'allow-human-read', effect: 'ALLOW' as const, match: { permission: Permissions.audit.read, principalId: 'alice' } },
        ];
  return new AuditAccessController({
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy(rules) }),
    ...(opts.kinds !== undefined ? { allowedPrincipalKinds: opts.kinds } : {}),
    ...(opts.revoked !== undefined ? { isRevoked: async (p) => opts.revoked!.has(p.id) } : {}),
  });
}
