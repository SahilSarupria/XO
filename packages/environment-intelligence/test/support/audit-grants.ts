import { AuditAccessController } from '@xo/audit';
import { Permissions, PermissionManager, RuleBasedPolicy, establishAuthenticatedPrincipal } from '@xo/permissions';

/** A single-use `read` grant for the service principal "auditor" (the only principal the test policy allows). */
export async function readGrant(): Promise<unknown> {
  const controller = new AuditAccessController({
    permissionManager: new PermissionManager({
      policy: new RuleBasedPolicy([
        { id: 'allow-audit-read', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'auditor' } },
      ]),
    }),
  });
  const auditor = establishAuthenticatedPrincipal({ kind: 'service', id: 'auditor' });
  if (!auditor.ok) throw auditor.error;
  const granted = await controller.authorize(auditor.value, 'read');
  if (!granted.ok) throw granted.error;
  return granted.value;
}
