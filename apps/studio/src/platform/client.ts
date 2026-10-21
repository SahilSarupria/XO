import type { AuthResult } from '../auth/oidc';
import {
  parseApiDescription,
  parseCapabilityList,
  parseCompilation,
  parseCompilationList,
  parseExecution,
  parseExecutionList,
  parseHealth,
  parseRegistryInspect,
  parseRegistrySearch,
  parseSource,
  parseSourceList,
  parseWorkflowList,
  parseWorkflowRun,
  parseWorkflowRunList,
  parseWorkspace,
  parseWorkspaceList,
  tryParseErrorBody,
  WireParseError,
  type ApiDescription,
  type BenchmarkRun,
  type Capability,
  type Compilation,
  type Execution,
  type RegistryPackage,
  type Source,
  type Workflow,
  type WorkflowRun,
  type Workspace,
} from './wire';

/**
 * Every way a call to the platform can end that is not a success. These are kept
 * distinct so the UI can never present an authorization failure, an unavailable
 * feature, or a garbled response as if it were a result.
 *
 *  unauthenticated  401 – no/invalid credential. Nothing was attempted.
 *  forbidden        403 – authenticated but not allowed (P1.0 M2 will produce these).
 *  not_found        404 – also what the API returns for another identity's resources.
 *  rejected         400/409/412/422 – the platform understood and refused the request.
 *  unavailable      501 – the platform deliberately does not offer this (e.g. AI execution).
 *  server           5xx – the platform failed.
 *  network          no HTTP response at all.
 *  malformed        HTTP success, but the body is not what the contract promises.
 */
export type ProblemKind = 'unauthenticated' | 'forbidden' | 'not_found' | 'rejected' | 'unavailable' | 'server' | 'network' | 'malformed';

export interface ApiProblem {
  readonly kind: ProblemKind;
  readonly status?: number;
  /** Platform error code (e.g. XO_RUNTIME_PERMISSION_DENIED), when the body carried one. */
  readonly code?: string;
  /** Platform-supplied reason (e.g. `stale_revision`, `stale_step_execution`), when the error body carried one. */
  readonly reason?: string;
  /** One platform sentence per refused capability on a permission denial. */
  readonly denials?: readonly string[];
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ApiProblem };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (problem: ApiProblem): Result<never> => ({ ok: false, problem });

export function classifyStatus(status: number): ProblemKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 501) return 'unavailable';
  if (status >= 500) return 'server';
  return 'rejected';
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface XoClientOptions {
  /** Same-origin proxy prefix in dev/prod; see vite.config.ts. */
  readonly baseUrl?: string;
  /** Static bearer (development access key). Exactly one of apiKey / bearer is required. */
  readonly apiKey?: string;
  /** Per-request bearer source (OIDC access token, refreshed as needed). */
  readonly bearer?: () => Promise<AuthResult<string>>;
  readonly fetch?: FetchLike;
}

/** Extensions the API accepts at upload (apps/api/src/sources/source.ts SUPPORTED_EXTENSIONS). */
export const SUPPORTED_UPLOAD_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.html',
  '.htm',
  '.json',
  '.csv',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
];

export class XoClient {
  private readonly baseUrl: string;
  private readonly bearer: () => Promise<AuthResult<string>>;
  private readonly doFetch: FetchLike;

  constructor(opts: XoClientOptions) {
    this.baseUrl = (opts.baseUrl ?? '/api').replace(/\/$/, '');
    const key = opts.apiKey;
    if (opts.bearer !== undefined) this.bearer = opts.bearer;
    else if (key !== undefined) this.bearer = () => Promise.resolve({ ok: true as const, value: key });
    else throw new Error('XoClient needs apiKey or bearer');
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async call<T>(
    method: string,
    path: string,
    parse: (body: unknown) => T,
    init?: { body?: BodyInit; contentType?: string; headers?: Readonly<Record<string, string>> },
  ): Promise<Result<T>> {
    const token = await this.bearer();
    if (!token.ok) {
      return fail({
        kind: token.failure.kind === 'network' ? 'network' : 'unauthenticated',
        message: token.failure.kind === 'network' ? 'Could not reach the sign-in service to refresh your session.' : token.failure.message,
      });
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token.value}`, Accept: 'application/json' };
    if (init?.contentType !== undefined) headers['Content-Type'] = init.contentType;
    if (init?.headers !== undefined) Object.assign(headers, init.headers);

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      });
    } catch {
      return fail({ kind: 'network', message: 'Could not reach the XO service.' });
    }

    let body: unknown;
    const text = await response.text().catch(() => '');
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const err = tryParseErrorBody(body);
      return fail({
        kind: classifyStatus(response.status),
        status: response.status,
        ...(err !== undefined ? { code: err.code } : {}),
        ...(err?.reason !== undefined ? { reason: err.reason } : {}),
        ...(err?.denials !== undefined ? { denials: err.denials } : {}),
        message: err?.message ?? `The XO service responded with status ${response.status}.`,
      });
    }

    try {
      return ok(parse(body));
    } catch (cause) {
      const detail = cause instanceof WireParseError ? cause.message : 'unreadable response';
      return fail({
        kind: 'malformed',
        status: response.status,
        message: `The XO service returned a response Studio could not trust (${detail}).`,
      });
    }
  }

  private json(body: unknown): { body: string; contentType: string } {
    return { body: JSON.stringify(body), contentType: 'application/json' };
  }

  // ---- platform description (read-only; both are public routes on the platform)
  getHealth(): Promise<Result<{ readonly status: string }>> {
    return this.call('GET', '/health', parseHealth);
  }
  getApiDescription(): Promise<Result<ApiDescription>> {
    return this.call('GET', '/openapi.json', parseApiDescription);
  }

  // ---- workspaces
  listWorkspaces(): Promise<Result<Workspace[]>> {
    return this.call('GET', '/workspaces', parseWorkspaceList);
  }
  createWorkspace(name: string): Promise<Result<Workspace>> {
    return this.call('POST', '/workspaces', (b) => parseWorkspace(b), this.json({ name }));
  }

  // ---- sources (context)
  listSources(ws: string): Promise<Result<Source[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/sources`, parseSourceList);
  }
  async uploadSource(ws: string, file: File): Promise<Result<Source>> {
    const buf = await readBytes(file);
    return this.call('POST', `/workspaces/${enc(ws)}/sources?filename=${encodeURIComponent(file.name)}`, (b) => parseSource(b), {
      body: buf,
      ...(file.type.length > 0 ? { contentType: file.type } : {}),
    });
  }

  // ---- registry (read-only). The registry has no "list everything" route: it answers a search, or one package.
  searchRegistry(ws: string, query: string): Promise<Result<RegistryPackage[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/registry/search?q=${encodeURIComponent(query)}`, parseRegistrySearch);
  }
  inspectPackage(ws: string, packageId: string): Promise<Result<{ record: RegistryPackage; runs: BenchmarkRun[] }>> {
    return this.call('GET', `/workspaces/${enc(ws)}/registry/packages/${enc(packageId)}/inspect`, parseRegistryInspect);
  }

  // ---- compilation (analysis)
  compileSource(ws: string, sourceId: string): Promise<Result<Compilation>> {
    return this.call('POST', `/workspaces/${enc(ws)}/sources/${enc(sourceId)}/compile`, (b) => parseCompilation(b));
  }
  listCompilations(ws: string): Promise<Result<Compilation[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/compilations`, parseCompilationList);
  }
  getCapabilities(ws: string, compilationId: string): Promise<Result<Capability[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/compilations/${enc(compilationId)}/capabilities`, parseCapabilityList);
  }

  // ---- approval + execution
  async approveCapability(ws: string, compilationId: string, capabilityId: string): Promise<Result<{ approvedAt: string }>> {
    return this.call('POST', `/workspaces/${enc(ws)}/compilations/${enc(compilationId)}/capabilities/${enc(capabilityId)}/approve`, (b) => {
      const o = b as { approvedAt?: unknown; status?: unknown };
      if (o?.status !== 'approved' || typeof o.approvedAt !== 'string') throw new WireParseError('approval', 'approved record');
      return { approvedAt: o.approvedAt };
    });
  }
  createExecution(ws: string, compilationId: string, capabilityId: string, input: Record<string, unknown>): Promise<Result<Execution>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/executions`,
      (b) => parseExecution(b),
      this.json({ compilationId, capabilityId, input }),
    );
  }
  listExecutions(ws: string): Promise<Result<Execution[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/executions`, parseExecutionList);
  }
  resolveHumanTask(ws: string, executionId: string, decision: 'approve' | 'reject', note?: string): Promise<Result<Execution>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/executions/${enc(executionId)}/resolve`,
      (b) => parseExecution(b),
      this.json({ decision, ...(note !== undefined ? { data: { note } } : {}) }),
    );
  }

  // ---- workflows
  listWorkflows(ws: string): Promise<Result<Workflow[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflows`, parseWorkflowList);
  }
  /**
   * Starts a run. Without `idempotencyKey` two calls make two runs. With one, a retry of the SAME request
   * (same workflow, analysis and key) returns the original run; reusing the key for a different request is a 409.
   * Callers still check for an active run first, and only reuse a key for a retry of the same intent.
   */
  startWorkflow(ws: string, workflowId: string, compilationId: string, idempotencyKey?: string): Promise<Result<WorkflowRun>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflows/${enc(workflowId)}/executions`, (b) => parseWorkflowRun(b), {
      ...this.json({ compilationId }),
      // With a key, the platform returns the ORIGINAL run for a retry of the same request instead of creating another.
      ...(idempotencyKey !== undefined ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  listWorkflowRuns(ws: string): Promise<Result<WorkflowRun[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-executions`, parseWorkflowRunList);
  }
  getWorkflowRun(ws: string, workflowExecutionId: string): Promise<Result<WorkflowRun>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-executions/${enc(workflowExecutionId)}`, (b) => parseWorkflowRun(b));
  }
  /**
   * Recovery of an `interrupted` run: the platform's own resume with NO decision. The platform re-runs the
   * interrupted step as a new attempt under a new execution id and keeps the earlier one on record.
   * `expectedRevision` must come from a freshly fetched run; a stale value is a 409 and nothing happens.
   */
  recoverWorkflowRun(ws: string, workflowExecutionId: string, args: { expectedRevision: number }): Promise<Result<WorkflowRun>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-executions/${enc(workflowExecutionId)}/resume`,
      (b) => parseWorkflowRun(b),
      this.json(args),
    );
  }
  /** `expectedStepExecutionId` and `expectedRevision` come from the authoritative run record, never from a cached guess. */
  resumeWorkflowRun(
    ws: string,
    workflowExecutionId: string,
    args: { decision: 'approve' | 'reject'; expectedStepExecutionId: string; expectedRevision: number; note?: string },
  ): Promise<Result<WorkflowRun>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-executions/${enc(workflowExecutionId)}/resume`,
      (b) => parseWorkflowRun(b),
      this.json({
        decision: args.decision,
        expectedStepExecutionId: args.expectedStepExecutionId,
        expectedRevision: args.expectedRevision,
        // The platform stores `data` on the step's human task. The note travels as `data.note` and nothing else.
        ...(args.note !== undefined ? { data: { note: args.note } } : {}),
      }),
    );
  }
}

const enc = encodeURIComponent;

/** Blob.arrayBuffer() where available, FileReader otherwise (older browsers, jsdom). */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('unreadable file')));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable file'));
    reader.readAsArrayBuffer(file);
  });
}
