import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { toPrincipalSnapshot, Permissions, type PermissionManager, type PermissionId } from '@xo/permissions';
import { PackageId } from '@xo/types';
import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';
import { isAuthorityField, MAX_PROCEDURE_BYTES, parseStrictJson, validateProcedure, type ProcedureFinding } from '@xo/procedure';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { BodyTooLargeError } from '../http/body.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePrincipal,
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceExecutionsStore,
  workspaceIdempotencyStore,
  workspaceProcedureExecutionsStore,
  workspaceProceduresStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { auditedOwnedWorkspace, finalizationNotice, newCorrelationId, safeId, type AuditService } from '../audit/audit-service.js';
import { FsProcedureStore } from '../procedures/fs-procedure-store.js';
import {
  isValidProcedureId,
  parseVersionParam,
  PROCEDURE_APPROVAL_SCHEMA,
  PROCEDURE_RECORD_SCHEMA,
  type ProcedureApprovalRecord,
  type ProcedureVersionRecord,
  type StoredLookup,
} from '../procedures/procedure.js';
import {
  compilationLoaderFromStore,
  presumedEffectful,
  validateAgainstRegistry,
  type CompilationLoader,
  type RegistryResult,
} from '../procedures/registry-validation.js';
import { computeLifecycle, deriveProcedureApprovalBinding, type ProcedureLifecycle } from '../procedures/procedure-approval.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import {
  IdempotencyGate,
  fingerprintRequest,
  readIdempotencyKey,
  type IdempotencyClaim,
  type ResourceProbe,
} from '../idempotency/idempotency.js';
import { REPLAY_HEADER, gateIdempotent, recordInvalid } from '../idempotency/idempotency-http.js';
import {
  FsProcedureExecutionStore,
  isValidProcedureExecutionId,
  type ProcedureExecutionRecord,
} from '../procedures/procedure-execution.js';
import {
  rejectedFindings,
  resumeProcedureExecution,
  startProcedureExecution,
  type ProcedureRunnerContext,
} from '../procedures/procedure-runner.js';
import type { ExternalToolWiring } from '@xo/runtime';

/**
 * P1.1 M2 — procedure lifecycle over HTTP (authoring, validation, approval, read). NO execution route exists.
 *
 * Trust boundary (owner O-2): identity only from the authenticated request (`req.principal`); permissions only from the
 * server-side policy (default deny); capability/contract/binding facts only from this workspace's compilation registry;
 * human-gate and effect semantics are never read from a client document. Every error carries stable codes and JSON pointers,
 * never a submitted value.
 */

const REQUESTER = { packageId: PackageId('xo.procedures'), capabilityId: 'procedure-lifecycle' } as const;
const APPROVE_BODY_FIELDS = ['acknowledgment'] as const;
/** Approval-record / identity fields a client must never supply (in addition to the shared M1 authority-field set). */
const APPROVAL_AUTHORITY = new Set([
  'approver',
  'approverPrincipalId',
  'approvedAt',
  'status',
  'binding',
  'workspaceId',
  'procedureHash',
  'validationReportHash',
  'registryStateDigest',
]);

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

const ptr = (key: string): string => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

function rejected(message: string, findings: readonly ProcedureFinding[]): XoError {
  return new XoError(ErrorCode.INVALID_ARGUMENT, message, { context: { findings: findings.map((f) => ({ code: f.code, path: f.path })) } });
}

type Body = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly findings: readonly ProcedureFinding[] };

/** The route-level half of N-10: the owner-approved 262,144-byte cap is enforced WHILE reading, before parsing. Same constant as the library. */
async function readProcedureBody(req: ApiRequest): Promise<Body> {
  try {
    const bytes = req.rawBodyLimited !== undefined ? await req.rawBodyLimited(MAX_PROCEDURE_BYTES) : await req.rawBody();
    if (bytes.length > MAX_PROCEDURE_BYTES) return { ok: false, findings: [{ code: 'PROC_BODY_TOO_LARGE', path: '' }] };
    return { ok: true, bytes };
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) return { ok: false, findings: [{ code: 'PROC_BODY_TOO_LARGE', path: '' }] };
    throw cause;
  }
}

export function registerProcedureRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
  audit: AuditService,
  options: {
    readonly stepTimeoutMs?: number;
    readonly testBeforeStepExecute?: () => Promise<void>;
    readonly externalTools?: ExternalToolWiring;
  } = {},
): void {
  const auditCtx = { audit, workspaceStore };

  function stores(workspace: WorkspaceRecord): { procedures: FsProcedureStore; load: CompilationLoader } {
    return {
      procedures: new FsProcedureStore(workspaceProceduresStore(workspace, dataConfig), workspace.workspaceId),
      load: compilationLoaderFromStore(new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig))),
    };
  }

  function targetFor(workspace: WorkspaceRecord, procedureId: string | undefined): NonNullable<AuditEventDraft['target']> {
    const id = safeId(procedureId);
    return id !== undefined
      ? { kind: 'procedure', id, workspaceId: workspace.workspaceId }
      : { kind: 'workspace', id: workspace.workspaceId };
  }

  /** Default-deny permission gate. Runs BEFORE any body is read, any record is written, or any registry fact is disclosed. */
  async function requirePermission(
    req: ApiRequest,
    workspace: WorkspaceRecord,
    permission: PermissionId,
    spec: { action: string; correlationId: string },
  ): Promise<void> {
    const principal = requirePrincipal(req);
    let allowed = false;
    try {
      const decision = await permissionManager.check({ permission, requester: REQUESTER, principal: toPrincipalSnapshot(principal) });
      allowed = decision.effect === 'allow'; // 'prompt' and anything else is a denial: no interactive consent exists for procedures
    } catch {
      allowed = false; // a failing policy engine denies (fail closed)
    }
    if (allowed) return;
    await audit.tryRecord({
      type: 'procedure.denied',
      action: spec.action,
      outcome: 'denied',
      actor: actorFromPrincipal(principal),
      target: targetFor(workspace, safeId(req.params['procedureId'])),
      correlationId: spec.correlationId,
      reasonCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
      metadata: { permission: String(permission) },
    });
    throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, `permission "${String(permission)}" is required for this operation`);
  }

  async function describe(
    procedures: FsProcedureStore,
    load: CompilationLoader,
    record: ProcedureVersionRecord,
  ): Promise<{ lifecycle: ProcedureLifecycle; approval: StoredLookup<ProcedureApprovalRecord>; registry: RegistryResult | undefined }> {
    const approval = await procedures.getApproval(record.procedureId, record.version);
    if (!approval.ok) throw approval.error;
    const registry = approval.value.kind === 'ok' ? await validateAgainstRegistry(record.definition, load) : undefined;
    return { lifecycle: computeLifecycle(record, approval.value, registry), approval: approval.value, registry };
  }

  function view(
    record: ProcedureVersionRecord,
    d: { lifecycle: ProcedureLifecycle; approval: StoredLookup<ProcedureApprovalRecord>; registry: RegistryResult | undefined },
    detail: boolean,
  ): Record<string, unknown> {
    const steps = record.definition.steps;
    const assertedSteps = steps
      .filter(
        (s) =>
          s.kind === 'capability' &&
          (s.basis === 'author_asserted' || (s.inputBindings ?? []).some((b) => b.bindingStatus === 'author_asserted')),
      )
      .map((s) => s.id);
    const confidences = d.registry?.ok === true ? d.registry.snapshot.steps.map((s) => s.confidence) : [];
    return {
      procedureId: record.procedureId,
      version: record.version,
      procedureHash: record.procedureHash,
      lifecycle: d.lifecycle,
      // Execution does not exist in P1.1 M2; "executable" is computed at start (M3) and is never a stored boolean.
      executable: false,
      createdAt: record.createdAt,
      author: { kind: record.author.kind, id: record.author.id },
      unknowns: record.definition.unknowns ?? [],
      authorAssertedSteps: assertedSteps,
      ...(confidences.length > 0 ? { confidence: Math.min(...confidences) } : {}),
      ...(d.approval.kind === 'ok'
        ? {
            approval: {
              approvedAt: d.approval.record.approvedAt,
              approver: { kind: d.approval.record.approver.kind, id: d.approval.record.approver.id },
              procedureHash: d.approval.record.binding.procedureHash,
              validationReportHash: d.approval.record.binding.validationReportHash,
              registryStateDigest: d.approval.record.binding.registryStateDigest,
              ...(d.approval.record.acknowledgment !== undefined ? { acknowledgmentRecorded: true } : {}),
            },
          }
        : {}),
      ...(detail ? { definition: record.definition } : {}),
    };
  }

  // ── POST /procedures:validate — pure: persists nothing, calls no adapter ───────────────────────────────────────────
  async function validate(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'validate.procedure', correlationId });
    await requirePermission(req, workspace, Permissions.procedure.author, { action: 'validate.procedure', correlationId });
    const body = await readProcedureBody(req);
    let findings: readonly ProcedureFinding[] = [];
    let procedureHash: string | undefined;
    let registryStateDigest: string | undefined;
    if (!body.ok) findings = body.findings;
    else {
      const parsed = validateProcedure(body.bytes);
      if (!parsed.ok) findings = parsed.findings;
      else {
        procedureHash = parsed.procedureHash;
        const registry = await validateAgainstRegistry(parsed.definition, stores(workspace).load);
        if (registry.ok) registryStateDigest = registry.snapshot.digest;
        else findings = registry.findings;
      }
    }
    const valid = findings.length === 0;
    // The report is only released after durable evidence that a validation happened (fail closed: no audit => no disclosure).
    await audit.requireDurable({
      type: 'procedure.validated',
      action: 'validate.procedure',
      outcome: valid ? 'completed' : 'failed',
      actor: actorFromPrincipal(requirePrincipal(req)),
      target: { kind: 'workspace', id: workspace.workspaceId },
      correlationId,
      ...(valid ? {} : { reasonCode: findings[0]?.code ?? ErrorCode.INVALID_ARGUMENT }),
      metadata: {
        valid,
        findingCount: findings.length,
        ...(procedureHash !== undefined ? { procedureHashPrefix: procedureHash.slice(0, 23) } : {}),
      },
    });
    return json(200, {
      valid,
      findings: findings.map((f) => ({ code: f.code, path: f.path })),
      ...(procedureHash !== undefined ? { procedureHash } : {}),
      ...(registryStateDigest !== undefined ? { registryStateDigest } : {}),
    });
  }

  // ── PUT /procedures/:procedureId/versions/:version — draft create; immutable thereafter ───────────────────────────────
  async function putVersion(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'author.procedure', correlationId });
    // 1. Authorization FIRST. An unauthorized author never gets as far as reading a body, and no file is ever created.
    await requirePermission(req, workspace, Permissions.procedure.author, { action: 'author.procedure', correlationId });
    const principal = requirePrincipal(req);
    const procedureId = req.params['procedureId'];
    const version = parseVersionParam(req.params['version']);
    if (!isValidProcedureId(procedureId) || version === undefined) {
      throw rejected('procedure rejected', [{ code: 'PROC_INVALID_FIELD', path: '/path' }]);
    }
    const base = {
      action: 'author.procedure',
      actor: actorFromPrincipal(principal),
      target: targetFor(workspace, procedureId),
      correlationId,
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;

    const body = await readProcedureBody(req);
    const failWith = async (findings: readonly ProcedureFinding[]): Promise<never> => {
      await audit.tryRecord({
        ...base,
        type: 'procedure.validated',
        outcome: 'failed',
        reasonCode: findings[0]?.code ?? ErrorCode.INVALID_ARGUMENT,
        metadata: { valid: false, findingCount: findings.length },
      });
      throw rejected('procedure definition rejected', findings);
    };
    if (!body.ok) return failWith(body.findings);
    const parsed = validateProcedure(body.bytes);
    if (!parsed.ok) return failWith(parsed.findings);
    // The URL names the resource; the document must say the same thing (no silent re-targeting).
    const mismatch: ProcedureFinding[] = [];
    if (parsed.definition.procedureId !== procedureId) mismatch.push({ code: 'PROC_PATH_MISMATCH', path: '/procedureId' });
    if (parsed.definition.version !== version) mismatch.push({ code: 'PROC_PATH_MISMATCH', path: '/version' });
    if (mismatch.length > 0) return failWith(mismatch);

    const record: ProcedureVersionRecord = {
      schemaVersion: PROCEDURE_RECORD_SCHEMA,
      workspaceId: workspace.workspaceId,
      procedureId,
      version,
      procedureHash: parsed.procedureHash,
      createdAt: new Date().toISOString(),
      author: { kind: principal.kind, id: principal.id, ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}) },
      definition: parsed.definition,
    };
    const meta = { version, procedureHashPrefix: parsed.procedureHash.slice(0, 23) };
    await audit.requireDurable({ ...base, type: 'procedure.attempted', outcome: 'attempted', metadata: meta });
    const { procedures } = stores(workspace);
    const created = await procedures.createVersion(record);
    if (!created.ok) throw created.error;
    if (!created.value.created) {
      await audit.finalize(
        { ...base, type: 'procedure.authored', outcome: 'failed', reasonCode: ErrorCode.ALREADY_EXISTS, metadata: meta },
        { correlationId },
      );
      throw new XoError(
        ErrorCode.ALREADY_EXISTS,
        `procedure "${procedureId}" version ${version} already exists; published versions are immutable`,
      );
    }
    const finalization = await audit.finalize(
      { ...base, type: 'procedure.authored', outcome: 'completed', metadata: meta },
      { correlationId },
    );
    return json(201, {
      ...view(record, { lifecycle: 'draft', approval: { kind: 'none' }, registry: undefined }, false),
      ...finalizationNotice(finalization),
    });
  }

  async function readGate(req: ApiRequest, action: string, procedureId: string | undefined): Promise<{ workspace: WorkspaceRecord }> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, Permissions.procedure.read, { action, correlationId });
    // PROTECTED READ: durable "attempted" evidence BEFORE anything is read or disclosed.
    await audit.requireDurable({
      type: 'access.attempted',
      action,
      outcome: 'attempted',
      actor: actorFromPrincipal(requirePrincipal(req)),
      target: targetFor(workspace, procedureId),
      correlationId,
    });
    return { workspace };
  }

  // ── GET /procedures ───────────────────────────────────────────────────────────────────────────────────────────────
  async function list(req: ApiRequest): Promise<ApiResponse> {
    const { workspace } = await readGate(req, 'read.procedures', undefined);
    const { procedures, load } = stores(workspace);
    const all = await procedures.listAll();
    if (!all.ok) throw all.error;
    const items: Record<string, unknown>[] = [];
    for (const [procedureId, versions] of [...all.value.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rows: Record<string, unknown>[] = [];
      for (const version of versions) {
        const found = await procedures.getVersion(procedureId, version);
        if (!found.ok) throw found.error;
        if (found.value.kind !== 'ok') {
          rows.push({ version, lifecycle: 'record_invalid' });
          continue;
        }
        const d = await describe(procedures, load, found.value.record);
        rows.push({
          version,
          procedureHash: found.value.record.procedureHash,
          lifecycle: d.lifecycle,
          executable: false,
          createdAt: found.value.record.createdAt,
        });
      }
      items.push({ procedureId, versions: rows });
    }
    return json(200, { procedures: items });
  }

  // ── GET /procedures/:procedureId[?version=n] ──────────────────────────────────────────────────────────────────────────
  async function get(req: ApiRequest): Promise<ApiResponse> {
    const procedureId = req.params['procedureId'];
    const { workspace } = await readGate(req, 'read.procedure', procedureId);
    const notFound = new NotFoundError(`procedure "${safeId(procedureId) ?? 'unknown'}"`);
    if (!isValidProcedureId(procedureId)) throw notFound;
    const { procedures, load } = stores(workspace);
    let version: number | undefined;
    const requested = req.query.get('version');
    if (requested !== null) {
      version = parseVersionParam(requested);
      if (version === undefined) throw notFound;
    } else {
      const all = await procedures.listAll();
      if (!all.ok) throw all.error;
      const versions = all.value.get(procedureId);
      version = versions === undefined ? undefined : versions[versions.length - 1];
    }
    if (version === undefined) throw notFound;
    const found = await procedures.getVersion(procedureId, version);
    if (!found.ok) throw found.error;
    if (found.value.kind === 'none') throw notFound;
    if (found.value.kind === 'malformed') throw new XoError(ErrorCode.UNKNOWN, 'stored procedure record failed integrity verification');
    const d = await describe(procedures, load, found.value.record);
    return json(200, view(found.value.record, d, true));
  }

  // ── POST /procedures/:procedureId/versions/:version/approve ───────────────────────────────────────────────────────────
  async function approve(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'approve.procedure', correlationId });
    await requirePermission(req, workspace, Permissions.procedure.approve, { action: 'approve.procedure', correlationId });
    // ATTRIBUTION: the approver is the authenticated principal. No body field, header or query parameter can name one.
    const approver = requirePrincipal(req);
    const procedureId = req.params['procedureId'];
    const version = parseVersionParam(req.params['version']);
    const base = {
      action: 'approve.procedure',
      actor: actorFromPrincipal(approver),
      target: targetFor(workspace, procedureId),
      correlationId,
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    const deny = async (reasonCode: string): Promise<void> => {
      await audit.tryRecord({ ...base, type: 'procedure.approval.denied', outcome: 'denied', reasonCode });
    };
    const notFound = new NotFoundError(`procedure "${safeId(procedureId) ?? 'unknown'}"`);
    if (!isValidProcedureId(procedureId) || version === undefined) {
      await deny(ErrorCode.NOT_FOUND);
      throw notFound;
    }
    const { procedures, load } = stores(workspace);
    const found = await procedures.getVersion(procedureId, version);
    if (!found.ok) throw found.error;
    if (found.value.kind === 'none') {
      await deny(ErrorCode.NOT_FOUND);
      throw notFound;
    }
    if (found.value.kind === 'malformed') {
      await deny('PROCEDURE_RECORD_INVALID');
      throw new XoError(ErrorCode.UNKNOWN, 'stored procedure record failed integrity verification');
    }
    const record = found.value.record;

    // Body: strict, closed, size-capped. Only `acknowledgment` is accepted; every authority-bearing name is rejected explicitly.
    const bodyRead = await readProcedureBody(req);
    let acknowledgment: string | undefined;
    if (!bodyRead.ok) {
      await deny(ErrorCode.INVALID_ARGUMENT);
      throw rejected('approval request rejected', bodyRead.findings);
    }
    if (bodyRead.bytes.length > 0) {
      const parsedBody = parseStrictJson(bodyRead.bytes);
      if (!parsedBody.ok) {
        await deny(ErrorCode.INVALID_ARGUMENT);
        throw rejected('approval request rejected', parsedBody.findings);
      }
      const value = parsedBody.value;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        await deny(ErrorCode.INVALID_ARGUMENT);
        throw rejected('approval request rejected', [{ code: 'PROC_NOT_AN_OBJECT', path: '' }]);
      }
      const findings: ProcedureFinding[] = [];
      for (const key of Object.keys(value)) {
        if ((APPROVE_BODY_FIELDS as readonly string[]).includes(key)) continue;
        findings.push({
          code: isAuthorityField(key) || APPROVAL_AUTHORITY.has(key) ? 'PROC_AUTHORITY_FIELD' : 'PROC_UNKNOWN_FIELD',
          path: ptr(key),
        });
      }
      const ack = (value as Record<string, unknown>)['acknowledgment'];
      if (ack !== undefined && (typeof ack !== 'string' || ack.trim().length === 0))
        findings.push({ code: 'PROC_INVALID_FIELD', path: '/acknowledgment' });
      if (findings.length > 0) {
        await deny(ErrorCode.INVALID_ARGUMENT);
        throw rejected('approval request rejected', findings);
      }
      if (typeof ack === 'string') acknowledgment = ack;
    }

    // Fresh, authoritative validation against the registry AT APPROVAL TIME. Approval is only reachable with zero blocking findings.
    const registry = await validateAgainstRegistry(record.definition, load);
    if (!registry.ok) {
      await deny('PROCEDURE_VALIDATION_FAILED');
      throw rejected('procedure does not validate against the registry; it cannot be approved', registry.findings);
    }
    // A-1 / A-3: no automatic path, and a service principal cannot approve a procedure presumed effectful (advisory write intent or external tool).
    if (approver.kind === 'service' && presumedEffectful(record.definition, registry.snapshot)) {
      await deny('PROCEDURE_APPROVER_NOT_HUMAN');
      throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, 'a service principal cannot approve a procedure that may have side effects');
    }
    // Author-asserted steps and unknowns must be acknowledged by the approver in words (XO never silently promotes them).
    const needsAck =
      (record.definition.unknowns ?? []).length > 0 ||
      (view(record, { lifecycle: 'draft', approval: { kind: 'none' }, registry: undefined }, false)['authorAssertedSteps'] as string[])
        .length > 0;
    if (needsAck && acknowledgment === undefined) {
      await deny('PROCEDURE_ACKNOWLEDGMENT_REQUIRED');
      throw rejected('this procedure has author-asserted steps or unknowns; approval requires an acknowledgment', [
        { code: 'PROC_MISSING_FIELD', path: '/acknowledgment' },
      ]);
    }

    const binding = deriveProcedureApprovalBinding(record, registry.snapshot, approver.id);
    const meta = {
      version,
      procedureHashPrefix: record.procedureHash.slice(0, 23),
      registryDigestPrefix: registry.snapshot.digest.slice(0, 23),
    };
    // PRECONDITION: durable evidence that an approval is being granted BEFORE it is stored (fail closed).
    await audit.requireDurable({ ...base, type: 'procedure.attempted', outcome: 'attempted', metadata: meta });
    const approval: ProcedureApprovalRecord = {
      schemaVersion: PROCEDURE_APPROVAL_SCHEMA,
      workspaceId: workspace.workspaceId,
      procedureId,
      version,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approver: { kind: approver.kind, id: approver.id, ...(approver.orgId !== undefined ? { orgId: approver.orgId } : {}) },
      ...(acknowledgment !== undefined ? { acknowledgment } : {}),
      binding,
    };
    const stored = await procedures.putApproval(approval);
    if (!stored.ok) throw stored.error;
    const finalization = await audit.finalize(
      { ...base, type: 'procedure.approval.granted', outcome: 'completed', metadata: meta },
      { correlationId },
    );
    const d = await describe(procedures, load, record);
    return json(200, { ...view(record, d, false), ...finalizationNotice(finalization) });
  }

  // ════════════════════════════ P1.1 M3 — execution (effect-free) ════════════════════════════

  function runnerContext(workspace: WorkspaceRecord, req: ApiRequest, correlationId: string): ProcedureRunnerContext {
    return {
      workspace,
      principal: requirePrincipal(req),
      permissionManager,
      compilationStore: new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)),
      approvalStore: new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig)),
      executionStore: new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig)),
      procedures: new FsProcedureStore(workspaceProceduresStore(workspace, dataConfig), workspace.workspaceId),
      records: new FsProcedureExecutionStore(workspaceProcedureExecutionsStore(workspace, dataConfig), workspace.workspaceId),
      audit,
      correlationId,
      ...(options.stepTimeoutMs !== undefined ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
      ...(options.testBeforeStepExecute !== undefined ? { testBeforeStepExecute: options.testBeforeStepExecute } : {}),
      ...(options.externalTools !== undefined ? { externalTools: options.externalTools } : {}),
    };
  }

  /** Closed JSON object body: only `allowed` fields; authority-bearing names are rejected explicitly; never echoes a value. */
  async function readClosedBody(req: ApiRequest, allowed: readonly string[], allowEmpty: boolean): Promise<Record<string, unknown>> {
    const body = await readProcedureBody(req);
    if (!body.ok) throw rejectedFindings('request rejected', body.findings);
    if (body.bytes.length === 0) {
      if (allowEmpty) return {};
      throw rejectedFindings('request rejected', [{ code: 'PROC_MISSING_FIELD', path: '' }]);
    }
    const parsed = parseStrictJson(body.bytes);
    if (!parsed.ok) throw rejectedFindings('request rejected', parsed.findings);
    const value = parsed.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw rejectedFindings('request rejected', [{ code: 'PROC_NOT_AN_OBJECT', path: '' }]);
    const findings: ProcedureFinding[] = [];
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      findings.push({
        code: isAuthorityField(key) || APPROVAL_AUTHORITY.has(key) ? 'PROC_AUTHORITY_FIELD' : 'PROC_UNKNOWN_FIELD',
        path: ptr(key),
      });
    }
    if (findings.length > 0) throw rejectedFindings('request rejected', findings);
    return value as Record<string, unknown>;
  }

  function executionView(record: ProcedureExecutionRecord): Record<string, unknown> {
    const waiting = record.waitingStepId === undefined ? undefined : record.steps.find((s) => s.stepId === record.waitingStepId);
    return {
      procedureExecutionId: record.procedureExecutionId,
      procedureId: record.procedureId,
      version: record.version,
      procedureHash: record.procedureHash,
      status: record.status,
      revision: record.revision,
      initiator: { kind: record.initiator.kind, id: record.initiator.id },
      steps: record.steps.map((s) => ({
        stepId: s.stepId,
        capabilityId: s.capabilityId,
        status: s.status,
        ...(s.executionId !== undefined ? { executionId: s.executionId } : {}),
        ...(s.failureClass !== undefined ? { failureClass: s.failureClass } : {}),
        ...(s.errorCode !== undefined ? { errorCode: s.errorCode } : {}),
      })),
      outputs: record.outputs,
      ...(waiting?.executionId !== undefined ? { waitingFor: { stepId: waiting.stepId, executionId: waiting.executionId } } : {}),
      ...(record.failure !== undefined ? { failure: { class: record.failure.class, code: record.failure.code } } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    };
  }

  // ── POST /procedures/:procedureId/versions/:version/executions ───────────────────────────────────────────────────────
  async function start(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'start.procedure', correlationId });
    // Authorization FIRST: a denied caller reads no body, creates no record, runs nothing.
    await requirePermission(req, workspace, Permissions.procedure.execute, { action: 'start.procedure', correlationId });
    const principal = requirePrincipal(req);
    const procedureId = req.params['procedureId'];
    const version = parseVersionParam(req.params['version']);
    const notFound = new NotFoundError(`procedure "${safeId(procedureId) ?? 'unknown'}"`);
    if (!isValidProcedureId(procedureId) || version === undefined) throw notFound;
    const body = await readClosedBody(req, ['input'], true);
    const rawInput = body['input'];
    if (rawInput !== undefined && (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput))) {
      throw rejectedFindings('procedure input rejected', [{ code: 'PROC_INVALID_FIELD', path: '/input' }]);
    }
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const idemKey = readIdempotencyKey(req.headers);
    if (!idemKey.ok) throw idemKey.error;
    const ctx = runnerContext(workspace, req, correlationId);
    const found = await ctx.procedures.getVersion(procedureId, version);
    if (!found.ok) throw found.error;
    if (found.value.kind === 'none') throw notFound;
    if (found.value.kind === 'malformed') throw new XoError(ErrorCode.UNKNOWN, 'stored procedure record failed integrity verification');
    const record = found.value.record;
    const base = {
      action: 'start.procedure',
      actor: actorFromPrincipal(principal),
      target: targetFor(workspace, procedureId),
      correlationId,
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    // Durable evidence of the attempt BEFORE anything is checked against the registry or run (fail closed).
    await audit.requireDurable({
      ...base,
      type: 'procedure.attempted',
      outcome: 'attempted',
      metadata: { version, procedureHashPrefix: record.procedureHash.slice(0, 23) },
    });
    const probe: ResourceProbe = async (resource) => {
      const existing = await ctx.records.get(resource.id);
      if (!existing.ok) return 'absent';
      return existing.value.initiator.id === principal.id && existing.value.workspaceId === workspace.workspaceId ? 'done' : 'foreign';
    };
    let claim: IdempotencyClaim | undefined;
    let replayed = false;
    const gate =
      idemKey.value === undefined
        ? undefined
        : {
            gate: async () => {
              const gated = await gateIdempotent(new IdempotencyGate(workspaceIdempotencyStore(workspace, dataConfig)), audit, base, {
                operation: 'start.procedure',
                workspaceId: workspace.workspaceId,
                principal: { kind: principal.kind, id: principal.id },
                key: idemKey.value as string,
                fingerprint: fingerprintRequest('start.procedure', { procedureId, version, procedureHash: record.procedureHash, input }),
                probe,
              });
              if (gated.kind === 'replay') {
                if (gated.resource.kind !== 'procedure-execution') throw recordInvalid();
                replayed = true;
                return { kind: 'replay' as const, procedureExecutionId: gated.resource.id };
              }
              claim = gated.claim;
              return { kind: 'proceed' as const };
            },
            beforeCreate: async (executionId: string) => {
              if (claim === undefined || !(await claim.attach({ kind: 'procedure-execution', id: executionId }))) {
                throw new XoError(ErrorCode.IO_ERROR, 'the idempotency record could not be written; nothing was started');
              }
            },
          };
    let result: ProcedureExecutionRecord;
    try {
      result = await startProcedureExecution(ctx, record, input, gate ?? {});
    } catch (cause) {
      await (claim as IdempotencyClaim | undefined)?.abort(probe);
      if (cause instanceof XoError && !cause.code.startsWith('XO_IDEMPOTENCY_')) {
        if (cause.code === ErrorCode.RUNTIME_PERMISSION_DENIED) {
          await audit.tryRecord({ ...base, type: 'procedure.denied', outcome: 'denied', reasonCode: cause.code });
        } else if (cause.code === ErrorCode.INVALID_ARGUMENT) {
          await audit.tryRecord({
            ...base,
            type: 'procedure.validated',
            outcome: 'failed',
            reasonCode: cause.code,
            metadata: { valid: false, phase: 'start-input' },
          });
        }
      }
      throw cause;
    } finally {
      (claim as IdempotencyClaim | undefined)?.dispose();
    }
    if (replayed) return json(result.status === 'failed' ? 200 : 201, executionView(result), REPLAY_HEADER);
    await (claim as IdempotencyClaim | undefined)?.complete();
    return json(result.status === 'failed' ? 200 : 201, executionView(result));
  }

  // ── GET /procedure-executions/:executionId ───────────────────────────────────────────────────────────────────────────
  async function getExecution(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'read.procedure-execution', correlationId });
    await requirePermission(req, workspace, Permissions.procedure.read, { action: 'read.procedure-execution', correlationId });
    const id = req.params['executionId'];
    await audit.requireDurable({
      type: 'access.attempted',
      action: 'read.procedure-execution',
      outcome: 'attempted',
      actor: actorFromPrincipal(requirePrincipal(req)),
      target: isValidProcedureExecutionId(id)
        ? { kind: 'procedure-execution', id, workspaceId: workspace.workspaceId }
        : { kind: 'workspace', id: workspace.workspaceId },
      correlationId,
    });
    const records = new FsProcedureExecutionStore(workspaceProcedureExecutionsStore(workspace, dataConfig), workspace.workspaceId);
    const found = await records.get(id ?? '');
    if (!found.ok) throw found.error;
    return json(200, executionView(found.value));
  }

  // ── POST /procedure-executions/:executionId/resume ───────────────────────────────────────────────────────────────────
  async function resume(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'resume.procedure', correlationId });
    await requirePermission(req, workspace, Permissions.procedure.execute, { action: 'resume.procedure', correlationId });
    const principal = requirePrincipal(req);
    const id = req.params['executionId'];
    const notFound = new NotFoundError('procedure execution');
    if (!isValidProcedureExecutionId(id)) throw notFound;
    const body = await readClosedBody(req, ['decision', 'data', 'expectedRevision', 'expectedStepExecutionId'], false);
    const findings: ProcedureFinding[] = [];
    const decision = body['decision'];
    if (decision !== 'approve' && decision !== 'reject') findings.push({ code: 'PROC_INVALID_FIELD', path: '/decision' });
    const data = body['data'];
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data)))
      findings.push({ code: 'PROC_INVALID_FIELD', path: '/data' });
    const expectedRevision = body['expectedRevision'];
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)
    )
      findings.push({ code: 'PROC_INVALID_FIELD', path: '/expectedRevision' });
    const expectedStep = body['expectedStepExecutionId'];
    if (expectedStep !== undefined && typeof expectedStep !== 'string')
      findings.push({ code: 'PROC_INVALID_FIELD', path: '/expectedStepExecutionId' });
    if (findings.length > 0) throw rejectedFindings('resume request rejected', findings);
    const ctx = runnerContext(workspace, req, correlationId);
    const existing = await ctx.records.get(id);
    if (!existing.ok) throw existing.error;
    const base = {
      action: 'resume.procedure',
      actor: actorFromPrincipal(principal),
      target: { kind: 'procedure-execution' as const, id, workspaceId: workspace.workspaceId },
      correlationId,
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    await audit.requireDurable({
      ...base,
      type: 'procedure.attempted',
      outcome: 'attempted',
      metadata: { revision: existing.value.revision },
    });
    try {
      const result = await resumeProcedureExecution(ctx, id, {
        decision: decision as 'approve' | 'reject',
        ...(data !== undefined ? { data: data as Record<string, unknown> } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision: expectedRevision as number } : {}),
        ...(expectedStep !== undefined ? { expectedStepExecutionId: expectedStep as string } : {}),
      });
      return json(200, executionView(result));
    } catch (cause) {
      if (cause instanceof XoError && cause.code === ErrorCode.RUNTIME_PERMISSION_DENIED) {
        await audit.tryRecord({ ...base, type: 'procedure.denied', outcome: 'denied', reasonCode: cause.code });
      }
      throw cause;
    }
  }

  router.post('/workspaces/:workspaceId/procedures:validate', guarded(validate));
  router.get('/workspaces/:workspaceId/procedures', guarded(list));
  router.get('/workspaces/:workspaceId/procedures/:procedureId', guarded(get));
  router.add('PUT', '/workspaces/:workspaceId/procedures/:procedureId/versions/:version', guarded(putVersion));
  router.post('/workspaces/:workspaceId/procedures/:procedureId/versions/:version/approve', guarded(approve));
  router.post('/workspaces/:workspaceId/procedures/:procedureId/versions/:version/executions', guarded(start));
  router.get('/workspaces/:workspaceId/procedure-executions/:executionId', guarded(getExecution));
  router.post('/workspaces/:workspaceId/procedure-executions/:executionId/resume', guarded(resume));
}
