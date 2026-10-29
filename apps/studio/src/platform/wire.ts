/**
 * Wire types for the parts of @xo/api that Studio consumes, plus runtime parsers.
 *
 * Why hand-declared and parsed instead of imported from @xo/*:
 *  - Studio is a browser bundle and must not pull in Node-oriented platform packages.
 *  - Everything arriving over the network is untrusted until parsed. A response that
 *    does not match is surfaced as a `malformed` problem, never rendered as truth.
 *
 * Shapes mirror apps/api/src (workspace.ts, sources/source.ts, compilations/compilation.ts,
 * executions/execution.ts, workflows/*). They are a *consumer* view: if the API changes a
 * field, the parser fails loudly here rather than the UI silently showing nonsense.
 */

export class WireParseError extends Error {
  constructor(
    public readonly path: string,
    expected: string,
  ) {
    super(`unexpected response shape at ${path}: expected ${expected}`);
    this.name = 'WireParseError';
  }
}

type Json = Record<string, unknown>;

export function obj(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new WireParseError(path, 'object');
  return v as Json;
}
export function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new WireParseError(path, 'string');
  return v;
}
export function optStr(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : str(v, path);
}
export function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new WireParseError(path, 'number');
  return v;
}
export function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new WireParseError(path, 'boolean');
  return v;
}
export function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new WireParseError(path, 'array');
  return v;
}
export function strArr(v: unknown, path: string): string[] {
  return arr(v, path).map((x, i) => str(x, `${path}[${i}]`));
}

// ---------------------------------------------------------------- workspace
export type WorkspaceRole = 'admin' | 'publisher' | 'reviewer' | 'viewer';
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'publisher', 'reviewer', 'viewer'];

export interface Workspace {
  readonly workspaceId: string;
  readonly name?: string;
  readonly createdAt: string;
  /** Absent on a server that predates workspace metadata. */
  readonly kind?: 'team' | 'personal';
  readonly region?: string;
  readonly regionLabel?: string;
  /** Owner plus members. */
  readonly memberCount?: number;
  /** The caller's own role here. Used to decide what to OFFER; the server still enforces every action. */
  readonly role?: WorkspaceRole;
}
export function parseWorkspace(v: unknown, path = 'workspace'): Workspace {
  const o = obj(v, path);
  const name = optStr(o['name'], `${path}.name`);
  const kind = optStr(o['kind'], `${path}.kind`);
  const region = optStr(o['region'], `${path}.region`);
  const regionLabel = optStr(o['regionLabel'], `${path}.regionLabel`);
  const role = optStr(o['role'], `${path}.role`);
  return {
    workspaceId: str(o['workspaceId'], `${path}.workspaceId`),
    ...(name !== undefined ? { name } : {}),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
    ...(kind === 'team' || kind === 'personal' ? { kind } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(regionLabel !== undefined ? { regionLabel } : {}),
    ...(o['memberCount'] !== undefined ? { memberCount: num(o['memberCount'], `${path}.memberCount`) } : {}),
    ...(role !== undefined && (WORKSPACE_ROLES as readonly string[]).includes(role) ? { role: role as WorkspaceRole } : {}),
  };
}
export function parseWorkspaceList(v: unknown): Workspace[] {
  return arr(obj(v, 'body')['workspaces'], 'workspaces').map((w, i) => parseWorkspace(w, `workspaces[${i}]`));
}

// ------------------------------------------------------------------ sources
export interface Source {
  readonly sourceId: string;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly digestSha256: string;
  readonly createdAt: string;
}
export function parseSource(v: unknown, path = 'source'): Source {
  const o = obj(v, path);
  return {
    sourceId: str(o['sourceId'], `${path}.sourceId`),
    originalFilename: str(o['originalFilename'], `${path}.originalFilename`),
    mediaType: str(o['mediaType'], `${path}.mediaType`),
    byteSize: num(o['byteSize'], `${path}.byteSize`),
    digestSha256: str(o['digestSha256'], `${path}.digestSha256`),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
  };
}
export function parseSourceList(v: unknown): Source[] {
  return arr(obj(v, 'body')['sources'], 'sources').map((s, i) => parseSource(s, `sources[${i}]`));
}

// ------------------------------------------------------------ compilations
export type CompilationStatus = 'running' | 'succeeded' | 'failed';
export interface Compilation {
  readonly compilationId: string;
  readonly sourceId: string;
  readonly sourceDigestSha256: string;
  readonly status: CompilationStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}
export function parseCompilation(v: unknown, path = 'compilation'): Compilation {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (status !== 'running' && status !== 'succeeded' && status !== 'failed') {
    throw new WireParseError(`${path}.status`, 'running|succeeded|failed');
  }
  const completedAt = optStr(o['completedAt'], `${path}.completedAt`);
  const errorCode = optStr(o['errorCode'], `${path}.errorCode`);
  const errorMessage = optStr(o['errorMessage'], `${path}.errorMessage`);
  return {
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    sourceId: str(o['sourceId'], `${path}.sourceId`),
    sourceDigestSha256: str(o['sourceDigestSha256'], `${path}.sourceDigestSha256`),
    status,
    createdAt: str(o['createdAt'], `${path}.createdAt`),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}
export function parseCompilationList(v: unknown): Compilation[] {
  return arr(obj(v, 'body')['compilations'], 'compilations').map((c, i) => parseCompilation(c, `compilations[${i}]`));
}

// ------------------------------------------------------------ capabilities
export type BindingStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'denied';
export interface Provenance {
  readonly documentPath: string;
  readonly locator?: string;
  readonly pages?: readonly number[];
}
/**
 * The platform's authoritative input contract for a capability (`CapabilityInputSchema` in @xo/types,
 * published on the capability projection as `inputContract`). Flat by design: primitive properties only.
 * ABSENT means "no published contract" — never "no inputs needed".
 */
export type InputPropertyType = 'string' | 'number' | 'boolean';
export interface InputContract {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, { readonly type: InputPropertyType }>>;
}

export interface Capability {
  readonly capabilityId: string;
  readonly contractId: string;
  readonly name: string;
  /** For discovered rules this is the source clause text. */
  readonly description: string;
  readonly status: BindingStatus;
  readonly executionClass?: string;
  readonly reason?: string;
  readonly confidence: number;
  readonly declaredConfidence?: { readonly score: number; readonly basis: string };
  readonly provenance: readonly Provenance[];
  readonly inputContract?: InputContract;
  readonly approved: boolean;
}

function parseInputContract(v: unknown, path: string): InputContract {
  const o = obj(v, path);
  if (o['type'] !== 'object') throw new WireParseError(`${path}.type`, 'object');
  const rawProps = obj(o['properties'], `${path}.properties`);
  const properties: Record<string, { readonly type: InputPropertyType }> = {};
  for (const [name, def] of Object.entries(rawProps)) {
    const t = obj(def, `${path}.properties.${name}`)['type'];
    if (t !== 'string' && t !== 'number' && t !== 'boolean')
      throw new WireParseError(`${path}.properties.${name}.type`, 'string|number|boolean');
    properties[name] = { type: t };
  }
  const required = strArr(o['required'], `${path}.required`);
  // A contract that requires a property it never declares cannot be trusted to drive a form.
  for (const r of required) if (!(r in properties)) throw new WireParseError(`${path}.required`, 'only declared properties');
  return { required, properties };
}
export function parseCapability(v: unknown, path = 'capability'): Capability {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (status !== 'resolved' && status !== 'unresolved' && status !== 'ambiguous' && status !== 'denied') {
    throw new WireParseError(`${path}.status`, 'resolved|unresolved|ambiguous|denied');
  }
  const executionClass = optStr(o['executionClass'], `${path}.executionClass`);
  const reason = optStr(o['reason'], `${path}.reason`);
  let declaredConfidence: Capability['declaredConfidence'];
  if (o['declaredConfidence'] !== undefined) {
    const d = obj(o['declaredConfidence'], `${path}.declaredConfidence`);
    declaredConfidence = {
      score: num(d['score'], `${path}.declaredConfidence.score`),
      basis: str(d['basis'], `${path}.declaredConfidence.basis`),
    };
  }
  const provenance = arr(o['provenance'], `${path}.provenance`).map((p, i) => {
    const pp = `${path}.provenance[${i}]`;
    const po = obj(p, pp);
    const locator = optStr(po['locator'], `${pp}.locator`);
    const pages = po['pages'] === undefined ? undefined : arr(po['pages'], `${pp}.pages`).map((n, j) => num(n, `${pp}.pages[${j}]`));
    return {
      documentPath: str(po['documentPath'], `${pp}.documentPath`),
      ...(locator !== undefined ? { locator } : {}),
      ...(pages !== undefined ? { pages } : {}),
    };
  });
  return {
    capabilityId: str(o['capabilityId'], `${path}.capabilityId`),
    contractId: str(o['contractId'], `${path}.contractId`),
    name: str(o['name'], `${path}.name`),
    description: str(o['description'], `${path}.description`),
    status,
    ...(executionClass !== undefined ? { executionClass } : {}),
    ...(reason !== undefined ? { reason } : {}),
    confidence: num(o['confidence'], `${path}.confidence`),
    ...(declaredConfidence !== undefined ? { declaredConfidence } : {}),
    provenance,
    ...(o['inputContract'] !== undefined ? { inputContract: parseInputContract(o['inputContract'], `${path}.inputContract`) } : {}),
    approved: bool(o['approved'], `${path}.approved`),
  };
}
export function parseCapabilityList(v: unknown): Capability[] {
  return arr(obj(v, 'body')['capabilities'], 'capabilities').map((c, i) => parseCapability(c, `capabilities[${i}]`));
}

// -------------------------------------------------------------- executions
export type ExecutionStatus = 'succeeded' | 'failed' | 'waiting_for_human' | 'rejected' | 'running';
export interface HumanTask {
  readonly status: 'pending' | 'resolved';
  readonly decision?: 'approve' | 'reject';
  /** The optional note the resolver attached (`decisionData.note`), exactly as the platform stored it. */
  readonly decisionNote?: string;
  readonly resolverId?: string;
  readonly resolvedAt?: string;
}
export interface Execution {
  readonly executionId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly status: ExecutionStatus;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly humanTask?: HumanTask;
  readonly initiator?: { readonly kind: string; readonly id: string };
  readonly bindingId?: string;
  readonly graphHash?: string;
}
const EXEC_STATUSES = new Set(['succeeded', 'failed', 'waiting_for_human', 'rejected', 'running']);
export function parseExecution(v: unknown, path = 'execution'): Execution {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (!EXEC_STATUSES.has(status)) throw new WireParseError(`${path}.status`, 'known execution status');
  let humanTask: HumanTask | undefined;
  if (o['humanTask'] !== undefined) {
    const h = obj(o['humanTask'], `${path}.humanTask`);
    const hs = str(h['status'], `${path}.humanTask.status`);
    if (hs !== 'pending' && hs !== 'resolved') throw new WireParseError(`${path}.humanTask.status`, 'pending|resolved');
    const decision = optStr(h['decision'], `${path}.humanTask.decision`);
    if (decision !== undefined && decision !== 'approve' && decision !== 'reject') {
      throw new WireParseError(`${path}.humanTask.decision`, 'approve|reject');
    }
    let decisionNote: string | undefined;
    if (typeof h['decisionData'] === 'object' && h['decisionData'] !== null) {
      const n = (h['decisionData'] as Json)['note'];
      if (typeof n === 'string') decisionNote = n;
    }
    const resolverId = optStr(h['resolverIdentityId'], `${path}.humanTask.resolverIdentityId`);
    const resolvedAt = optStr(h['resolvedAt'], `${path}.humanTask.resolvedAt`);
    humanTask = {
      status: hs,
      ...(decision !== undefined ? { decision } : {}),
      ...(decisionNote !== undefined ? { decisionNote } : {}),
      ...(resolverId !== undefined ? { resolverId } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    };
  }
  let initiator: Execution['initiator'];
  if (o['initiator'] !== undefined) {
    const i = obj(o['initiator'], `${path}.initiator`);
    initiator = { kind: str(i['kind'], `${path}.initiator.kind`), id: str(i['id'], `${path}.initiator.id`) };
  }
  const completedAt = optStr(o['completedAt'], `${path}.completedAt`);
  const errorCode = optStr(o['errorCode'], `${path}.errorCode`);
  const errorMessage = optStr(o['errorMessage'], `${path}.errorMessage`);
  const bindingId = optStr(o['bindingId'], `${path}.bindingId`);
  const graphHash = optStr(o['graphHash'], `${path}.graphHash`);
  return {
    executionId: str(o['executionId'], `${path}.executionId`),
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    capabilityId: str(o['capabilityId'], `${path}.capabilityId`),
    status: status as ExecutionStatus,
    requestedAt: str(o['requestedAt'], `${path}.requestedAt`),
    ...(completedAt !== undefined ? { completedAt } : {}),
    input: o['input'],
    ...(o['output'] !== undefined ? { output: o['output'] } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(humanTask !== undefined ? { humanTask } : {}),
    ...(initiator !== undefined ? { initiator } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
    ...(graphHash !== undefined ? { graphHash } : {}),
  };
}
export function parseExecutionList(v: unknown): Execution[] {
  return arr(obj(v, 'body')['executions'], 'executions').map((e, i) => parseExecution(e, `executions[${i}]`));
}

// --------------------------------------------------------------- workflows
export interface Workflow {
  readonly workflowId: string;
  readonly compilationId: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly executable: boolean;
  readonly notExecutableReasons: readonly string[];
  readonly gapCount: number;
  readonly stepCount: number;
  readonly steps: readonly WorkflowStepSummary[];
  readonly requiresHumanDecision: boolean;
  readonly confidence: number;
}
/** One step of a workflow as the platform composed it (`order` is the platform's own sequence). */
export interface WorkflowStepSummary {
  readonly order: number;
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
}
export function parseWorkflowList(v: unknown): Workflow[] {
  return arr(obj(v, 'body')['workflows'], 'workflows').map((w, i) => {
    const p = `workflows[${i}]`;
    const o = obj(w, p);
    return {
      workflowId: str(o['workflowId'], `${p}.workflowId`),
      compilationId: str(o['compilationId'], `${p}.compilationId`),
      name: str(o['name'], `${p}.name`),
      description: str(o['description'], `${p}.description`),
      status: str(o['status'], `${p}.status`),
      executable: bool(o['executable'], `${p}.executable`),
      notExecutableReasons: strArr(o['notExecutableReasons'], `${p}.notExecutableReasons`),
      gapCount: arr(o['gaps'], `${p}.gaps`).length,
      stepCount: arr(o['steps'], `${p}.steps`).length,
      steps: arr(o['steps'], `${p}.steps`).map((st, j) => {
        const sp = `${p}.steps[${j}]`;
        const so = obj(st, sp);
        return {
          order: num(so['order'], `${sp}.order`),
          capabilityId: str(so['capabilityId'], `${sp}.capabilityId`),
          name: str(so['name'], `${sp}.name`),
          description: typeof so['description'] === 'string' ? so['description'] : '',
        };
      }),
      requiresHumanDecision: bool(o['requiresHumanDecision'], `${p}.requiresHumanDecision`),
      confidence: num(o['confidence'], `${p}.confidence`),
    };
  });
}

// ------------------------------------------------------------------ errors
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  /** `error.context.reason` when the platform supplies one (e.g. a workflow concurrency conflict). */
  readonly reason?: string;
  /** `error.context.denials` on a permission denial: one platform sentence per refused capability. */
  readonly denials?: readonly string[];
}
/** Lenient on purpose: an unreadable error body must never mask the HTTP status. */
export function tryParseErrorBody(v: unknown): ApiErrorBody | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = (v as Json)['error'];
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as Json)['code'];
  const message = (e as Json)['message'];
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  const ctx = (e as Json)['context'];
  let reason: string | undefined;
  let denials: string[] | undefined;
  if (typeof ctx === 'object' && ctx !== null && !Array.isArray(ctx)) {
    const r = (ctx as Json)['reason'];
    if (typeof r === 'string') reason = r;
    const d = (ctx as Json)['denials'];
    if (Array.isArray(d) && d.every((x) => typeof x === 'string')) denials = d as string[];
  }
  return { code, message, ...(reason !== undefined ? { reason } : {}), ...(denials !== undefined ? { denials } : {}) };
}

// ------------------------------------------------------- workflow executions
export type WorkflowRunStatus = 'created' | 'running' | 'waiting_for_human' | 'succeeded' | 'failed' | 'rejected' | 'interrupted';
export type WorkflowStepStatus =
  'pending' | 'running' | 'waiting_for_human' | 'succeeded' | 'failed' | 'rejected' | 'skipped' | 'interrupted';
const RUN_STATUSES = new Set(['created', 'running', 'waiting_for_human', 'succeeded', 'failed', 'rejected', 'interrupted']);
const STEP_STATUSES = new Set(['pending', 'running', 'waiting_for_human', 'succeeded', 'failed', 'rejected', 'skipped', 'interrupted']);

export interface WorkflowRunStep {
  readonly stepId: string;
  readonly order: number;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly status: WorkflowStepStatus;
  readonly executionId?: string;
  /** Earlier attempts of this step that were interrupted and replaced by a recovery; kept by the platform for audit. */
  readonly supersededExecutionIds?: readonly string[];
  readonly errorMessage?: string;
}
export interface WorkflowRun {
  readonly workflowExecutionId: string;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  /** The platform's concurrency counter. Sent back as `expectedRevision` when resuming. */
  readonly revision: number;
  readonly status: WorkflowRunStatus;
  readonly steps: readonly WorkflowRunStep[];
  /** null once the run is terminal. */
  readonly currentStepIndex: number | null;
  /** The step execution a resume must name (`expectedStepExecutionId`). */
  readonly currentStepExecutionId?: string;
  readonly pendingHumanTask?: { readonly stepIndex: number; readonly executionId: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly initiator?: { readonly kind: string; readonly id: string };
  /** Present only for a run started from a saved draft: which draft revision, the path taken and each branch decision. */
  readonly draft?: {
    readonly definitionId: string;
    readonly revision: number;
    readonly path: readonly string[];
    readonly branches: readonly {
      readonly nodeId: string;
      readonly value: number;
      readonly threshold: number;
      readonly taken: 'gte' | 'lt';
    }[];
  };
  /** The platform's full record, kept only for Builder Mode's technical view. */
  readonly raw: unknown;
}
export function parseWorkflowRun(v: unknown, path = 'workflowExecution'): WorkflowRun {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (!RUN_STATUSES.has(status)) throw new WireParseError(`${path}.status`, 'known workflow status');
  const steps = arr(o['steps'], `${path}.steps`).map((st, i) => {
    const sp = `${path}.steps[${i}]`;
    const so = obj(st, sp);
    const ss = str(so['status'], `${sp}.status`);
    if (!STEP_STATUSES.has(ss)) throw new WireParseError(`${sp}.status`, 'known step status');
    const executionId = optStr(so['executionId'], `${sp}.executionId`);
    const superseded = Array.isArray(so['supersededExecutionIds'])
      ? (so['supersededExecutionIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    let errorMessage: string | undefined;
    if (typeof so['error'] === 'object' && so['error'] !== null) {
      const m = (so['error'] as Json)['message'];
      if (typeof m === 'string') errorMessage = m;
    }
    return {
      stepId: str(so['stepId'], `${sp}.stepId`),
      order: num(so['order'], `${sp}.order`),
      capabilityId: str(so['capabilityId'], `${sp}.capabilityId`),
      capabilityName: str(so['capabilityName'], `${sp}.capabilityName`),
      status: ss as WorkflowStepStatus,
      ...(executionId !== undefined ? { executionId } : {}),
      ...(superseded !== undefined && superseded.length > 0 ? { supersededExecutionIds: superseded } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  });
  const cur = o['currentStepIndex'];
  const currentStepIndex = cur === null || cur === undefined ? null : num(cur, `${path}.currentStepIndex`);
  let pendingHumanTask: WorkflowRun['pendingHumanTask'];
  if (o['pendingHumanTask'] !== undefined) {
    const p = obj(o['pendingHumanTask'], `${path}.pendingHumanTask`);
    pendingHumanTask = {
      stepIndex: num(p['stepIndex'], `${path}.pendingHumanTask.stepIndex`),
      executionId: str(p['executionId'], `${path}.pendingHumanTask.executionId`),
    };
  }
  let initiator: WorkflowRun['initiator'];
  if (o['initiator'] !== undefined) {
    const i = obj(o['initiator'], `${path}.initiator`);
    initiator = { kind: str(i['kind'], `${path}.initiator.kind`), id: str(i['id'], `${path}.initiator.id`) };
  }
  let draft: WorkflowRun['draft'];
  if (o['draft'] !== undefined) {
    const d = obj(o['draft'], `${path}.draft`);
    draft = {
      definitionId: str(d['definitionId'], `${path}.draft.definitionId`),
      revision: num(d['revision'], `${path}.draft.revision`),
      path: arr(d['path'], `${path}.draft.path`).map((x, i) => str(x, `${path}.draft.path[${i}]`)),
      branches: arr(d['branches'], `${path}.draft.branches`).map((b, i) => {
        const bp = `${path}.draft.branches[${i}]`;
        const bo = obj(b, bp);
        const taken = str(bo['taken'], `${bp}.taken`);
        if (taken !== 'gte' && taken !== 'lt') throw new WireParseError(`${bp}.taken`, 'gte or lt');
        return {
          nodeId: str(bo['nodeId'], `${bp}.nodeId`),
          value: num(bo['value'], `${bp}.value`),
          threshold: num(bo['threshold'], `${bp}.threshold`),
          taken,
        };
      }),
    };
  }
  const currentStepExecutionId = optStr(o['currentStepExecutionId'], `${path}.currentStepExecutionId`);
  const completedAt = optStr(o['completedAt'], `${path}.completedAt`);
  const errorCode = optStr(o['errorCode'], `${path}.errorCode`);
  const errorMessage = optStr(o['errorMessage'], `${path}.errorMessage`);
  return {
    workflowExecutionId: str(o['workflowExecutionId'], `${path}.workflowExecutionId`),
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    workflowId: str(o['workflowId'], `${path}.workflowId`),
    workflowName: str(o['workflowName'], `${path}.workflowName`),
    revision: num(o['revision'], `${path}.revision`),
    status: status as WorkflowRunStatus,
    steps,
    currentStepIndex,
    ...(currentStepExecutionId !== undefined ? { currentStepExecutionId } : {}),
    ...(pendingHumanTask !== undefined ? { pendingHumanTask } : {}),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
    updatedAt: str(o['updatedAt'], `${path}.updatedAt`),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(initiator !== undefined ? { initiator } : {}),
    ...(draft !== undefined ? { draft } : {}),
    raw: v,
  };
}
export function parseWorkflowRunList(v: unknown): WorkflowRun[] {
  return arr(obj(v, 'body')['workflowExecutions'], 'workflowExecutions').map((r, i) => parseWorkflowRun(r, `workflowExecutions[${i}]`));
}

// ---------------------------------------------------------------- API description (Builder Mode)
/** `GET /health`. Anything other than a string `status` is not a health answer Studio can show. */
export function parseHealth(v: unknown): { readonly status: string } {
  return { status: str(obj(v, 'health')['status'], 'health.status') };
}

export interface ApiOperation {
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  /** `security: []` on an operation means the platform serves it without credentials. */
  readonly requiresAuth: boolean;
}
export interface ApiDescription {
  readonly title: string;
  readonly version: string;
  readonly operations: readonly ApiOperation[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * `GET /openapi.json`: the platform's own description of its API. Only what Studio displays is read (title, version,
 * method, path, summary, whether the operation is open); unknown OpenAPI detail is ignored, not trusted or rendered.
 */
export function parseApiDescription(v: unknown): ApiDescription {
  const doc = obj(v, 'openapi');
  const info = obj(doc['info'], 'openapi.info');
  const paths = obj(doc['paths'], 'openapi.paths');
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const o = obj(item, `openapi.paths.${path}`);
    for (const method of HTTP_METHODS) {
      const op = o[method];
      if (op === undefined) continue;
      const od = obj(op, `openapi.paths.${path}.${method}`);
      const summary = od['summary'] === undefined ? undefined : str(od['summary'], `openapi.paths.${path}.${method}.summary`);
      const open = Array.isArray(od['security']) && od['security'].length === 0;
      operations.push({ method: method.toUpperCase(), path, ...(summary !== undefined ? { summary } : {}), requiresAuth: !open });
    }
  }
  return { title: str(info['title'], 'openapi.info.title'), version: str(info['version'], 'openapi.info.version'), operations };
}

// ---------------------------------------------------------------- registry (read-only)
/** A capability a published package declares in its manifest. */
export interface RegistryCapability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
/**
 * A published package as the workspace's registry holds it. Only what Studio shows: the registry's record carries no score,
 * rating, price or "verified" flag, so none is modelled here.
 */
export interface RegistryPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly publishedAt: string;
  readonly capabilities: readonly RegistryCapability[];
  /** How many signatures the manifest carries. Their validity is not judged here. */
  readonly signatureCount: number;
  readonly components: readonly { readonly kind: string; readonly path: string }[];
}
/** One recorded benchmark run. The registry does not state the scale of `score`, so Studio shows it as recorded. */
export interface BenchmarkRun {
  readonly id: string;
  readonly packageId: string;
  readonly category: string;
  readonly score: number;
  readonly runAt: string;
  readonly challengeable: boolean;
}
export function parseRegistryRecord(v: unknown, path = 'record'): RegistryPackage {
  const o = obj(v, path);
  const m = obj(o['manifest'], `${path}.manifest`);
  const caps = m['capabilities'] === undefined ? [] : arr(m['capabilities'], `${path}.manifest.capabilities`);
  const sigs = m['signatures'] === undefined ? [] : arr(m['signatures'], `${path}.manifest.signatures`);
  const comps = m['components'] === undefined ? {} : obj(m['components'], `${path}.manifest.components`);
  return {
    id: str(o['id'], `${path}.id`),
    name: str(m['name'], `${path}.manifest.name`),
    version: str(m['version'], `${path}.manifest.version`),
    creatorDid: str(m['creatorDid'], `${path}.manifest.creatorDid`),
    publishedAt: str(o['publishedAt'], `${path}.publishedAt`),
    capabilities: caps.map((c, i) => {
      const co = obj(c, `${path}.manifest.capabilities[${i}]`);
      return {
        id: str(co['id'], `${path}.manifest.capabilities[${i}].id`),
        name: str(co['name'], `${path}.manifest.capabilities[${i}].name`),
        description: str(co['description'], `${path}.manifest.capabilities[${i}].description`),
      };
    }),
    signatureCount: sigs.length,
    components: Object.entries(comps).map(([kind, e]) => ({
      kind,
      path: str(obj(e, `${path}.manifest.components.${kind}`)['path'], `${path}.manifest.components.${kind}.path`),
    })),
  };
}
export function parseBenchmarkRun(v: unknown, path = 'run'): BenchmarkRun {
  const o = obj(v, path);
  return {
    id: str(o['id'], `${path}.id`),
    packageId: str(o['packageId'], `${path}.packageId`),
    category: str(o['category'], `${path}.category`),
    score: num(o['score'], `${path}.score`),
    runAt: str(o['runAt'], `${path}.runAt`),
    challengeable: bool(o['challengeable'], `${path}.challengeable`),
  };
}
export function parseRegistrySearch(v: unknown): RegistryPackage[] {
  return arr(obj(v, 'body')['records'], 'records').map((r, i) => parseRegistryRecord(r, `records[${i}]`));
}
export function parseRegistryInspect(v: unknown): { record: RegistryPackage; runs: BenchmarkRun[] } {
  const o = obj(v, 'body');
  return {
    record: parseRegistryRecord(o['record']),
    runs: arr(o['benchmarkRuns'], 'benchmarkRuns').map((r, i) => parseBenchmarkRun(r, `benchmarkRuns[${i}]`)),
  };
}
