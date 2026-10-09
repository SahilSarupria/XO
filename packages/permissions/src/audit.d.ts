import type { PackageId } from '@xo/types';
import type { PermissionId } from './permission-id.js';
import type { PermissionScope } from './scope.js';
/** §17's required event vocabulary, verbatim. */
export type PermissionAuditEventType = 'permission.requested' | 'permission.allowed' | 'permission.denied' | 'permission.prompted' | 'permission.granted' | 'permission.revoked';
export interface PermissionAuditEvent {
    readonly type: PermissionAuditEventType;
    readonly at: string;
    readonly permission: PermissionId;
    readonly requesterPackageId: PackageId;
    readonly requesterCapabilityId?: string;
    readonly scope?: PermissionScope;
    readonly details?: Readonly<Record<string, unknown>>;
}
/**
 * Where audit events go — deliberately just this one method (§17: "do not
 * build a full logging platform"). A host wires this to its actual log
 * pipeline, a file, a DB table, wherever; `@xo/permissions` only needs to
 * guarantee it *calls* this at every state transition listed in §17.
 */
export interface PermissionAuditSink {
    record(event: PermissionAuditEvent): void;
}
export declare const noopAuditSink: PermissionAuditSink;
/** An in-memory sink for tests/inspection — not a production logging solution. */
export declare class InMemoryAuditSink implements PermissionAuditSink {
    private readonly events;
    record(event: PermissionAuditEvent): void;
    all(): readonly PermissionAuditEvent[];
    ofType(type: PermissionAuditEventType): readonly PermissionAuditEvent[];
}
//# sourceMappingURL=audit.d.ts.map