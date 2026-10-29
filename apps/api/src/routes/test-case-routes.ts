import { randomUUID } from 'node:crypto';
import { toRecordedAuthentication } from '../auth/recorded-authentication.js';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  requirePrincipal,
  workspaceCompilationsStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { roleOf, type WorkspaceRecord, type WorkspaceStore } from '../workspace/workspace.js';
import { roleAllows } from '../workspace/permissions.js';
import { recordAudit } from '../audit/record.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { createAndRunExecution } from '../executions/run-execution.js';
import { FsTestCaseStore } from '../test-cases/fs-test-case-store.js';
import { judge, parseTestCaseInput, type TestCase, type TestCaseRun } from '../test-cases/test-case.js';

/**
 * Saved test cases per capability, and their run history.
 *
 * Running a case is a real execution through `createAndRunExecution` — the same approval gate, input validation and
 * runtime bridge as `POST /executions` — and pass/fail is decided here from the persisted execution record, never
 * supplied by a client. A case that expects `waiting_for_human` really opens a human task. Nothing in this file
 * makes a network call or leaves the workspace's own state store, so air-gapped mode and the declared data region
 * are respected by construction.
 */
function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerTestCaseRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const cases = (w: WorkspaceRecord) => new FsTestCaseStore(workspaceStateStore(w, dataConfig), w.workspaceId);

  /** Ownership, then the permission gate (so a caller who may not do this learns nothing about ids), then lookups. */
  async function scope(req: ApiRequest, gate?: (workspace: WorkspaceRecord) => Promise<void>) {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    if (gate !== undefined) await gate(workspace);
    const compilationId = req.params['compilationId'] ?? '';
    const capabilityId = req.params['capabilityId'] ?? '';
    const store = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const compilation = await store.get(compilationId);
    if (!compilation.ok) throw compilation.error;
    const caps = await store.getCapabilities(compilationId);
    if (!caps.ok) throw caps.error;
    if (!caps.value.some((c) => c.capabilityId === capabilityId))
      throw new NotFoundError(`capability "${capabilityId}" in compilation "${compilationId}"`);
    return { workspace, compilationId, capabilityId, succeeded: compilation.value.status === 'succeeded' };
  }

  async function withLastRun(store: FsTestCaseStore, c: TestCase) {
    const [last] = await store.runs(c.caseId);
    return { ...c, ...(last !== undefined ? { lastRun: last } : {}) };
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const s = await scope(req);
    const store = cases(s.workspace);
    const found = await store.list(s.compilationId, s.capabilityId);
    return json(200, { testCases: await Promise.all(found.map((c) => withLastRun(store, c))) });
  }

  async function create(req: ApiRequest): Promise<ApiResponse> {
    const s = await scope(req, (w) => requirePermission(req, w, 'author', dataConfig, { action: 'save test case' }).then(() => undefined));
    const body = await req.json<unknown>();
    if (!body.ok) throw body.error;
    const { input } = parseTestCaseInput(body.value, { update: false });
    const c = await cases(s.workspace).create(s.compilationId, s.capabilityId, input, callerIdentityId(req), new Date());
    return json(201, c);
  }

  async function load(req: ApiRequest, gate?: (workspace: WorkspaceRecord) => Promise<void>) {
    const s = await scope(req, gate);
    const store = cases(s.workspace);
    const caseId = req.params['caseId'] ?? '';
    const c = await store.get(s.compilationId, s.capabilityId, caseId);
    if (c === undefined) throw new NotFoundError(`test case "${caseId}"`);
    return { ...s, store, testCase: c };
  }

  async function get(req: ApiRequest): Promise<ApiResponse> {
    const s = await load(req);
    return json(200, await withLastRun(s.store, s.testCase));
  }

  async function update(req: ApiRequest): Promise<ApiResponse> {
    const target = { kind: 'test_case', id: req.params['caseId'] ?? '' };
    const s = await load(req, (w) =>
      requirePermission(req, w, 'author', dataConfig, { action: 'edit test case', target }).then(() => undefined),
    );
    const body = await req.json<unknown>();
    if (!body.ok) throw body.error;
    const { input, expectedRevision } = parseTestCaseInput(body.value, { update: true });
    const next = await s.store.replace(
      s.compilationId,
      s.capabilityId,
      s.testCase.caseId,
      input,
      expectedRevision,
      callerIdentityId(req),
      new Date(),
    );
    if (next === undefined) throw new NotFoundError(`test case "${s.testCase.caseId}"`);
    return json(200, next);
  }

  async function remove(req: ApiRequest): Promise<ApiResponse> {
    const target = { kind: 'test_case', id: req.params['caseId'] ?? '' };
    const s = await load(req, (w) =>
      requirePermission(req, w, 'author', dataConfig, { action: 'delete test case', target }).then(() => undefined),
    );
    await s.store.delete(s.compilationId, s.capabilityId, s.testCase.caseId);
    return json(200, { deleted: true });
  }

  async function history(req: ApiRequest): Promise<ApiResponse> {
    const s = await load(req);
    return json(200, { runs: await s.store.runs(s.testCase.caseId) });
  }

  /** Author or reviewer may run (the existing role model: reviewers verify, authors build); anyone else is refused and audited as usual. */
  async function requireRunPermission(req: ApiRequest, workspace: WorkspaceRecord, target: { kind: string; id: string }): Promise<void> {
    const role = roleOf(workspace, callerIdentityId(req));
    if (role !== undefined && (roleAllows(role, 'author') || roleAllows(role, 'review'))) return;
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'run test case', target });
  }

  async function runOne(req: ApiRequest, workspace: WorkspaceRecord, store: FsTestCaseStore, c: TestCase): Promise<TestCaseRun> {
    const authentication = toRecordedAuthentication(req.authentication);
    const record = await createAndRunExecution(
      { workspace, dataConfig, principal: requirePrincipal(req), ...(authentication !== undefined ? { authentication } : {}) },
      { compilationId: c.compilationId, capabilityId: c.capabilityId, input: c.input },
    );
    const actual: TestCaseRun['actual'] = {
      status: record.status,
      ...(record.output !== undefined ? { output: record.output } : {}),
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    };
    const verdict = judge(c.expected, actual);
    const run: TestCaseRun = {
      runId: `tcr_${randomUUID().replace(/-/g, '')}`,
      caseId: c.caseId,
      caseRevision: c.revision,
      executionId: record.executionId,
      at: new Date().toISOString(),
      ranBy: callerIdentityId(req),
      pass: verdict.pass,
      actual,
      mismatches: verdict.mismatches,
    };
    await store.addRun(run);
    await recordAudit(req, workspace, dataConfig, {
      event: 'execution.test_run',
      result: record.status === 'failed' ? 'failed' : record.status === 'waiting_for_human' ? 'escalated' : 'succeeded',
      target: { kind: 'execution', id: record.executionId },
      detail: { caseId: c.caseId, compilationId: c.compilationId, capabilityId: c.capabilityId, pass: verdict.pass, status: record.status },
    });
    return run;
  }

  async function runCase(req: ApiRequest): Promise<ApiResponse> {
    const s = await load(req, (w) => requireRunPermission(req, w, { kind: 'test_case', id: req.params['caseId'] ?? '' }));
    if ((await req.rawBody()).length > 0)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'this endpoint takes no body; the input is the saved case');
    return json(200, await runOne(req, s.workspace, s.store, s.testCase));
  }

  async function runAll(req: ApiRequest): Promise<ApiResponse> {
    const s = await scope(req, (w) => requireRunPermission(req, w, { kind: 'capability', id: req.params['capabilityId'] ?? '' }));
    let only: readonly string[] | undefined;
    if ((await req.rawBody()).length > 0) {
      const body = await req.json<unknown>();
      if (!body.ok) throw body.error;
      const o = body.value as Record<string, unknown> | null;
      const ids = o !== null && typeof o === 'object' && !Array.isArray(o) ? o['caseIds'] : undefined;
      if (
        !(o !== null && typeof o === 'object' && Object.keys(o).every((k) => k === 'caseIds')) ||
        !Array.isArray(ids) ||
        ids.some((i) => typeof i !== 'string')
      )
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'body, if present, must be { "caseIds": string[] }');
      only = ids as string[];
    }
    const store = cases(s.workspace);
    const all = await store.list(s.compilationId, s.capabilityId);
    const chosen =
      only === undefined
        ? all
        : only.map(
            (id) =>
              all.find((c) => c.caseId === id) ??
              ((): never => {
                throw new NotFoundError(`test case "${id}"`);
              })(),
          );
    if (chosen.length === 0) return json(200, { runs: [], passed: 0, failed: 0 });
    const runs: TestCaseRun[] = [];
    // Sequential on purpose: each run is a real, audited execution, and a refused approval must stop before any later case runs.
    for (const c of chosen) runs.push(await runOne(req, s.workspace, store, c));
    return json(200, { runs, passed: runs.filter((r) => r.pass).length, failed: runs.filter((r) => !r.pass).length });
  }

  const base = '/workspaces/:workspaceId/compilations/:compilationId/capabilities/:capabilityId';
  router.get(`${base}/test-cases`, guarded(list));
  router.post(`${base}/test-cases`, guarded(create));
  router.get(`${base}/test-cases/:caseId`, guarded(get));
  router.put(`${base}/test-cases/:caseId`, guarded(update));
  router.delete(`${base}/test-cases/:caseId`, guarded(remove));
  router.get(`${base}/test-cases/:caseId/runs`, guarded(history));
  router.post(`${base}/test-cases/:caseId/runs`, guarded(runCase));
  router.post(`${base}/test-case-runs`, guarded(runAll));
}
