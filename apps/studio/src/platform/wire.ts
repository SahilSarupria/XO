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

function obj(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new WireParseError(path, 'object');
  return v as Json;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new WireParseError(path, 'string');
  return v;
}
function optStr(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : str(v, path);
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new WireParseError(path, 'number');
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new WireParseError(path, 'boolean');
  return v;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new WireParseError(path, 'array');
  return v;
}
function strArr(v: unknown, path: string): string[] {
  return arr(v, path).map((x, i) => str(x, `${path}[${i}]`));
}

// ---------------------------------------------------------------- workspace
export interface Workspace {
  readonly workspaceId: string;
  readonly name?: string;
  readonly createdAt: string;
}
export function parseWorkspace(v: unknown, path = 'workspace'): Workspace {
  const o = obj(v, path);
  const name = optStr(o['name'], `${path}.name`);
  return {
    workspaceId: str(o['workspaceId'], `${path}.workspaceId`),
    ...(name !== undefined ? { name } : {}),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
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
    humanTask = { status: hs, ...(decision !== undefined ? { decision } : {}) };
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
  readonly requiresHumanDecision: boolean;
  readonly confidence: number;
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
      requiresHumanDecision: bool(o['requiresHumanDecision'], `${p}.requiresHumanDecision`),
      confidence: num(o['confidence'], `${p}.confidence`),
    };
  });
}

// ------------------------------------------------------------------ errors
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
}
/** Lenient on purpose: an unreadable error body must never mask the HTTP status. */
export function tryParseErrorBody(v: unknown): ApiErrorBody | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = (v as Json)['error'];
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as Json)['code'];
  const message = (e as Json)['message'];
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
}
