import { AuditError, ErrorCode } from '@xo/errors';
import { isAuthenticatedPrincipal, toPrincipalSnapshot, Permissions, type PermissionManager } from '@xo/permissions';
import { PackageId, err, ok, type Result } from '@xo/types';

export type AuditAccessAction = 'read' | 'purge';

const PERMISSION_BY_ACTION = {
  read: Permissions.audit.read,
  purge: Permissions.audit.purge,
} as const;

/**
 * A single-use, short-lived proof that a verified principal was authorized for
 * an audit action AT THIS MOMENT. Only {@link AuditAccessController.authorize}
 * mints one (module-private registry); the store consumes it. A grant cannot
 * be forged, cloned, replayed (single use) or held (expires), so authorization
 * is re-evaluated on every access: a principal revoked or de-authorized after a
 * previous call is refused on the next one.
 */
export interface AuditAccessGrant {
  readonly kind: 'xo.audit.access-grant';
  readonly action: AuditAccessAction;
  readonly principalId: string;
  readonly principalKind: 'human' | 'service';
  readonly orgId?: string;
  readonly issuedAtMs: number;
}

const live = new WeakMap<object, AuditAccessGrant>();
const consumed = new WeakSet<object>();

/** Internal — the store calls this. Not exported from `index.ts`. */
export function consumeGrant(
  grant: unknown,
  action: AuditAccessAction,
  nowMs: number,
  maxAgeMs: number,
): Result<AuditAccessGrant, AuditError> {
  const deny = (why: string): Result<never, AuditError> =>
    err(new AuditError(ErrorCode.AUDIT_ACCESS_DENIED, `audit ${action} refused: ${why}`));
  if (typeof grant !== 'object' || grant === null || !live.has(grant)) return deny('no valid access grant');
  if (consumed.has(grant)) return deny('access grant already used');
  const g = live.get(grant) as AuditAccessGrant;
  if (g.action !== action) return deny('access grant is for a different action');
  if (nowMs - g.issuedAtMs > maxAgeMs || nowMs < g.issuedAtMs) return deny('access grant expired');
  consumed.add(grant);
  return ok(g);
}

export interface AuditAccessControllerOptions {
  /** The existing XO policy decision point (M2). Audit access is just two more permissions on it. */
  readonly permissionManager: PermissionManager;
  /**
   * Principal kinds that MAY be considered at all. Default `['service']`: audit
   * consumers are service principals unless the operator explicitly widens this.
   * The final decision is still the policy's — this only narrows, never grants.
   */
  readonly allowedPrincipalKinds?: readonly ('human' | 'service')[];
  /**
   * Re-evaluated on every access. Return true if the principal's credential/identity has been
   * revoked since authentication. Throwing is treated as revoked (fail closed).
   */
  readonly isRevoked?: (principal: { readonly id: string; readonly kind: 'human' | 'service' }) => Promise<boolean>;
  readonly clock?: () => number;
}

const AUDIT_REQUESTER = { packageId: PackageId('xo.audit'), capabilityId: 'audit-access' } as const;

export class AuditAccessController {
  private readonly kinds: ReadonlySet<string>;
  private readonly clock: () => number;
  constructor(private readonly options: AuditAccessControllerOptions) {
    this.kinds = new Set(options.allowedPrincipalKinds ?? ['service']);
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Default-deny. Every failure path is a denial value, never a throw and never an implicit allow. */
  async authorize(principal: unknown, action: AuditAccessAction): Promise<Result<AuditAccessGrant, AuditError>> {
    const deny = (why: string): Result<never, AuditError> =>
      err(new AuditError(ErrorCode.AUDIT_ACCESS_DENIED, `audit ${action} is not authorized: ${why}`));
    if (!isAuthenticatedPrincipal(principal)) return deny('no verified principal');
    if (!this.kinds.has(principal.kind)) return deny('principal kind is not permitted to access audit records');
    try {
      if (this.options.isRevoked !== undefined && (await this.options.isRevoked({ id: principal.id, kind: principal.kind }))) {
        return deny('principal is revoked');
      }
    } catch {
      return deny('revocation status could not be established');
    }
    let effect: string;
    try {
      const decision = await this.options.permissionManager.check({
        permission: PERMISSION_BY_ACTION[action],
        requester: AUDIT_REQUESTER,
        principal: toPrincipalSnapshot(principal),
      });
      effect = decision.effect;
    } catch {
      return deny('policy decision failed');
    }
    if (effect !== 'allow') return deny('policy does not allow it');
    const grant: AuditAccessGrant = Object.freeze({
      kind: 'xo.audit.access-grant' as const,
      action,
      principalId: principal.id,
      principalKind: principal.kind,
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
      issuedAtMs: this.clock(),
    });
    live.set(grant, grant);
    return ok(grant);
  }
}
