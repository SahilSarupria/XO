import { randomUUID } from 'node:crypto';
import { FileAuditStore, createRuntimeExecutionAudit, resolveAuditConfig, type RuntimeExecutionAuditPort } from '@xo/audit';

export type CliAuditResult =
  { readonly ok: true; readonly audit: RuntimeExecutionAuditPort | undefined } | { readonly ok: false; readonly message: string };

/**
 * P1.0 M4 — durable audit for the local CLI's direct runtime paths (`xo run`, `xo workflow`).
 *
 * The CLI operator is a trusted local context, not a principal (M2), so its events are recorded with the SYSTEM actor.
 *  - XO_AUDIT_DIR / XO_AUDIT_RETENTION_DAYS / XO_AUDIT_MIN_RETENTION_DAYS all set -> durable audit, FAIL CLOSED:
 *    if the "started" evidence cannot be fsync-confirmed the capability is not executed.
 *  - none set, NODE_ENV != production -> UNAUDITED local run (explicit limitation, see docs/audit-operations.md).
 *  - partial configuration, or NODE_ENV=production without configuration -> the command refuses to run.
 */
export async function openCliAudit(env: NodeJS.ProcessEnv = process.env): Promise<CliAuditResult> {
  const config = resolveAuditConfig(env);
  if (!config.ok) return { ok: false, message: config.error.message };
  if (config.value.mode === 'non-production') return { ok: true, audit: undefined };
  try {
    const store = await FileAuditStore.open({
      dir: config.value.dir,
      retention: { defaultRetentionMs: config.value.defaultRetentionMs, minimumRetentionMs: config.value.minimumRetentionMs },
    });
    return { ok: true, audit: createRuntimeExecutionAudit(store, `cli-${randomUUID()}`) };
  } catch {
    return { ok: false, message: 'audit store could not be opened' };
  }
}
