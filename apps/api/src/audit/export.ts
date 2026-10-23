import type { WorkspaceRecord } from '../workspace/workspace.js';
import { regionLabel } from '../workspace/regions.js';
import { permissionsOf } from '../workspace/permissions.js';
import type { FsAuditLog } from './fs-audit-log.js';
import type { AuditEntry, AuditVerification } from './audit-entry.js';
import { declaredRetentionDays } from './retention.js';

/**
 * A self-contained evidence pack for a compliance review (SOC 2 / ISO 27001 style evidence gathering).
 *
 * What it IS: the complete audit log, the result of re-verifying its hash chain at export time, the access-control
 * snapshot (who holds which role), and the declared retention and residency settings.
 * What it is NOT: a certification. Nothing in this pack claims the workspace is SOC 2 compliant; it is the raw,
 * checkable evidence an auditor asks for. `notices` states the limits explicitly so a reader cannot mistake it.
 */
export interface AuditExportPack {
  readonly format: 'xo-audit-evidence/1';
  readonly generatedAt: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly name?: string;
    readonly kind: string;
    readonly region?: string;
    readonly regionLabel?: string;
    readonly createdAt: string;
  };
  readonly accessControl: {
    readonly members: readonly {
      readonly identityId: string;
      readonly role: string;
      readonly isOwner: boolean;
      readonly permissions: readonly string[];
      readonly addedAt?: string;
    }[];
  };
  /** `minimumDays` is `null` unless the operator declared a policy (`XO_API_AUDIT_RETENTION_DAYS`); the server never invents one. */
  readonly retention: { readonly minimumDays: number | null; readonly deletionSupported: false; readonly enforcedByServer: false };
  readonly integrity: AuditVerification;
  readonly entries: readonly AuditEntry[];
  readonly notices: readonly string[];
}

export async function buildAuditExport(workspace: WorkspaceRecord, log: FsAuditLog, now: Date): Promise<AuditExportPack> {
  const [entries, integrity] = await Promise.all([log.all(), log.verify()]);
  const region = workspace.region;
  return {
    format: 'xo-audit-evidence/1',
    generatedAt: now.toISOString(),
    workspace: {
      workspaceId: workspace.workspaceId,
      ...(workspace.name !== undefined ? { name: workspace.name } : {}),
      kind: workspace.kind ?? 'team',
      ...(region !== undefined
        ? { region, ...(regionLabel(region) !== undefined ? { regionLabel: regionLabel(region) as string } : {}) }
        : {}),
      createdAt: workspace.createdAt,
    },
    accessControl: {
      members: [
        {
          identityId: workspace.identityId,
          role: 'admin',
          isOwner: true,
          permissions: permissionsOf('admin'),
          addedAt: workspace.createdAt,
        },
        ...(workspace.members ?? []).map((m) => ({
          identityId: m.identityId,
          role: m.role,
          isOwner: false,
          permissions: permissionsOf(m.role),
          addedAt: m.addedAt,
        })),
      ],
    },
    retention: { minimumDays: declaredRetentionDays(), deletionSupported: false, enforcedByServer: false },
    integrity,
    entries,
    notices: [
      'This is evidence, not a certification: it does not assert SOC 2 or ISO 27001 compliance.',
      'The hash chain makes partial edits detectable; it cannot detect a complete, internally consistent rewrite unless headHash was recorded elsewhere.',
      'Retention is whatever the operator declared (null = none declared); the server does not delete entries but cannot guarantee the durability of its own storage.',
      'Residency is declarative; the server does not prove where bytes are physically stored.',
    ],
  };
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // Neutralize spreadsheet formula injection (cells that start with = + - @ or tab/CR are executed by Excel/Sheets).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditExportToCsv(pack: AuditExportPack): string {
  const header = ['seq', 'at', 'actor', 'actor_role', 'event', 'target_kind', 'target_id', 'target_label', 'result', 'detail', 'hash'];
  const rows = pack.entries.map((e) =>
    [e.seq, e.at, e.actor.identityId, e.actor.role, e.event, e.target?.kind, e.target?.id, e.target?.label, e.result, e.detail, e.hash]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}
