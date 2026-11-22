/**
 * A stateful in-memory stand-in for @xo/api, used ONLY by tests (never bundled into the app).
 * It reproduces the real wire shapes captured from a live API run (see scripts/live-smoke.mjs,
 * which checks the same shapes against the real service). It can be told to fail in the ways the
 * real platform does: 401, 501, 403, a failed compilation, invalid execution input.
 */
export interface FakeCap {
  capabilityId: string;
  name: string;
  description: string;
  status: 'resolved' | 'unresolved';
  executionClass?: string;
  reason?: string;
  confidence: number;
  inputContract?: unknown;
}

/** Mirrors the flat CapabilityInputSchema the platform publishes (verified live by scripts/live-smoke.mjs). */
export const CONTRACT = {
  type: 'object',
  properties: { claim_amount: { type: 'number' }, loss: { type: 'string' }, reported: { type: 'boolean' } },
  required: ['claim_amount', 'loss'],
};

interface Body {
  name?: string;
  decision?: 'approve' | 'reject';
  compilationId: string;
  capabilityId: string;
  input: unknown;
}
interface FakeExecution {
  executionId: string;
  status: string;
  humanTask?: {
    status: string;
    decision?: string;
    decisionData?: Record<string, unknown>;
    resolverIdentityId?: string;
    resolvedAt?: string;
  };
  [k: string]: unknown;
}

/** A Set whose `has` can be forced true, so a test can say "everything is approved" without clicking through Review. */
class ApprovalSet extends Set<string> {
  all = false;
  override has(v: string): boolean {
    return this.all || super.has(v);
  }
}

import { StudioFake } from './fakeStudio';

export class FakeXo {
  /** The Studio-backend routes (members, audit, settings, library, chat, drafts, preview, link import). Admin caller by default. */
  studio = new StudioFake();
  validKey = 'xoak_good';
  workspaces: Array<{ workspaceId: string; name: string; createdAt: string }> = [];
  sources: Array<{ sourceId: string; originalFilename: string; byteSize: number }> = [];
  compilations: Array<{
    compilationId: string;
    sourceId: string;
    status: 'succeeded' | 'failed';
    createdAt: string;
    errorMessage?: string;
    errorCode?: string;
  }> = [];
  approvals = new ApprovalSet();
  executions: FakeExecution[] = [];
  /** When true, the deterministic capability publishes an input contract, as the platform now does. */
  publishContract = false;
  /** When true, every capability publishes the contract (so a multi-step draft run can show one generated form). */
  publishContractAll = false;
  caps: FakeCap[] = [
    {
      capabilityId: 'cap_det',
      name: 'Record before payment',
      description: '9.5 The settlement amount must be recorded before payment authorization.',
      status: 'resolved',
      executionClass: 'deterministic_rule',
      confidence: 0.5,
    },
    {
      capabilityId: 'cap_hitl',
      name: 'Review not covered',
      description: 'Claims outside the standard rule go to a human.',
      status: 'resolved',
      executionClass: 'human_in_the_loop',
      confidence: 0.45,
    },
    {
      capabilityId: 'cap_open',
      name: 'Notify the Insurer',
      description: '4.1 The Insured must notify within 7 days.',
      status: 'unresolved',
      reason: 'structured-comparison-resolver: no executable outcome',
      confidence: 0.55,
    },
  ];
  /** Simulates a stale view: the server refuses an approval Studio's view thought was allowed. */
  approveRefusal = false;
  /** Published packages and recorded benchmark runs, in the registry's real record shapes (read by the Library and the inspector). */
  registryPackages: Array<Record<string, any>> = [];
  benchmarkRuns: Array<Record<string, any>> = [];
  /** Workflow runs, in the platform's real record shape (see scripts/live-smoke.mjs). */
  workflowRuns: Array<Record<string, any>> = [];
  workflowExecutable = true;
  /** PX-8: what the readiness certificate says (the platform recomputes it; the fake just plays it back). */
  certificateStatus: 'READY' | 'NEEDS_REVIEW' | 'BLOCKED' = 'NEEDS_REVIEW';
  certificateCurrent = true;
  certifyCalls = 0;
  /** UW-10: the email bindings' tiers, as `GET …/connector-bindings` reports them. */
  emailTiers: Array<{ connector: string; tier: string; lookup: boolean; explanation: string }> = [];
  /** ADR 0031: the workspace requires a certificate to start; the certified definition needs the workflow runtime. */
  requireCertificate = false;
  irOnly = false;
  generatedRuns: Array<{
    runId: string;
    state: string;
    pendingApprovals: { approvalId: string; step: string; summary: string; expiresAt: string }[];
    decisions: unknown[];
  }> = [];
  /** UW-8/UW-12b: in production a run that sends starts only from an approved batch. */
  runApprovalRequired = false;
  /** Who the fake says prepared each preview (the caller is the workspace admin 'sally'). */
  previewPreparer = 'sally';
  /** With separation on, the person who prepared a preview cannot approve it. */
  separation = false;
  /** V1-1: where a once-per-item workflow's items can come from (default: it does not run once per item). */
  itemSources: { forEach: boolean; over?: string; fieldsUsed?: string[]; sources: Record<string, unknown>[] } = {
    forEach: false,
    sources: [],
  };
  previews: Array<{
    previewId: string;
    definitionId: string;
    certificateId: string;
    root: string;
    createdBy: string;
    items?: { connectionId: string; proposalId: string };
    approval?: { approvalId: string; reviewerId: string; approvedAt: string; expiresAt: string; usedBy?: string };
  }> = [];
  /** Calls whose outcome is unknown, waiting for a person to reconcile them. */
  unknownEffects: Array<{ definitionId: string; runId: string; parentRunId?: string; item?: number; step: string; connector: string }> = [];
  cancelled: string[] = [];
  reconciled: Array<{ runId: string; step: string; decision: string; reason: string }> = [];
  /** Workflow controls (mode, triggers, limit, sign-off, practice reviews, pause). `false` simulates a platform that predates them (404). */
  supportsControls = true;
  controls: {
    paused: boolean;
    reason?: string;
    mode: 'draft' | 'shadow' | 'live' | 'paused';
    webhook: boolean;
    schedule?: { everyMinutes: number; lastFiredAt: string; input?: Record<string, unknown> };
    cap?: number;
    signOff?: { identityId: string; displayName?: string; at: string };
    reviews: Record<string, 'automatic' | 'person'>;
  } = { paused: false, mode: 'draft', webhook: false, reviews: {} };
  /** 'ok' | throw before the server sees it | throw AFTER the server created the run (an ambiguous failure). */
  startBehavior: 'ok' | 'network_before' | 'network_after_create' = 'ok';
  resumeBehavior: 'ok' | 'network_before' | 'network_after_apply' = 'ok';
  /** Overrides the revision the next resume is compared against, simulating another client having moved the run on. */
  /** Simulates another client changing the run between Studio's read and its resume (a stale revision). */
  bumpRevisionBeforeResume = false;
  /** A lagging read: the runs list does not yet show runs that exist (lets a test exercise the key rather than the pre-check). */
  hideRunsFromList = false;
  /** Path suffixes that answer 500 while present (a transient platform failure on one list). */
  failing = new Set<string>();
  /** The platform refuses the next start with its approval denial even though the screen showed everything approved. */
  denyNextStart = false;
  /** The platform refuses the decision data (e.g. a capability's own decision-data schema). */
  rejectDecisionData = false;
  private rn = 0;
  failNextCompile: { errorMessage: string; errorCode: string } | undefined;
  executeBehavior: 'invalid_input' | 'binding_unresolved' | 'succeed' | 'waiting_for_human' | 'unavailable' | 'forbidden' = 'invalid_input';
  calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  /** Idempotency-Key -> run id, as the platform derives it (per request equality). */
  private startKeys = new Map<string, { runId: string; compilationId: string; workflowId: string }>();
  private n = 0;
  private id(p: string) {
    return `${p}_${(++this.n).toString(16).padStart(32, '0')}`;
  }

  /** What the platform persists when the driving process is lost mid-step (`withInterrupted`). */
  interruptRun(run: Record<string, any>) {
    const i = run.currentStepIndex as number;
    run.status = 'interrupted';
    run.steps[i].status = 'interrupted';
    run.revision += 1;
    delete run.pendingHumanTask;
    delete run.currentStepExecutionId;
  }

  /** The platform's recovery: the interrupted step re-runs under a NEW execution id; the old one is kept. */
  recoverRun(run: Record<string, any>) {
    const i = run.currentStepIndex as number;
    const old = run.steps[i].executionId as string | undefined;
    const exe = `exe_re${run.revision}_${run.workflowExecutionId}`;
    run.steps[i] = { ...run.steps[i], status: 'waiting_for_human', executionId: exe, ...(old ? { supersededExecutionIds: [old] } : {}) };
    run.status = 'waiting_for_human';
    run.revision += 3;
    run.currentStepExecutionId = exe;
    run.pendingHumanTask = { stepIndex: i, executionId: exe };
  }

  /** Applies a decision to a run the way the platform does, and also lets a test simulate ANOTHER client deciding. */
  applyDecision(run: Record<string, any>, decision: 'approve' | 'reject', data?: Record<string, unknown>) {
    const i = run.currentStepIndex as number;
    // The platform stores the decision (and any data) on the step's human-task execution, and lists that execution.
    this.executions.push({
      executionId: run.steps[i].executionId,
      compilationId: run.compilationId,
      capabilityId: run.steps[i].capabilityId,
      status: decision === 'approve' ? 'succeeded' : 'rejected',
      requestedAt: new Date().toISOString(),
      input: {},
      humanTask: {
        status: 'resolved',
        decision,
        ...(data !== undefined ? { decisionData: data } : {}),
        resolverIdentityId: 'sally',
        resolvedAt: new Date().toISOString(),
      },
    });
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
    if (decision === 'reject') {
      run.steps[i].status = 'rejected';
      run.status = 'rejected';
      run.currentStepIndex = null;
      delete run.currentStepExecutionId;
      delete run.pendingHumanTask;
      return;
    }
    run.steps[i].status = 'succeeded';
    run.completedStepExecutionIds.push(run.steps[i].executionId);
    if (i + 1 >= run.steps.length) {
      run.status = 'succeeded';
      run.currentStepIndex = null;
      delete run.currentStepExecutionId;
      delete run.pendingHumanTask;
      return;
    }
    const exe = `exe_s${i + 1}_${run.workflowExecutionId}`;
    run.steps[i + 1].status = 'waiting_for_human';
    run.steps[i + 1].executionId = exe;
    run.currentStepIndex = i + 1;
    run.currentStepExecutionId = exe;
    run.pendingHumanTask = { stepIndex: i + 1, executionId: exe };
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/^\/api/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    let body = {} as Body;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as Body;
      } catch {
        /* raw */
      }
    }
    this.calls.push({ method, path: path.split('?')[0]!, ...(typeof raw === 'string' ? { body } : {}), headers });

    const reply = (status: number, data?: unknown) => new Response(data === undefined ? '' : JSON.stringify(data), { status });
    const err = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

    if (headers['Authorization'] !== `Bearer ${this.validKey}`) return err(401, 'XO_AUTH_KEY_INVALID', 'invalid API key');

    let m: RegExpMatchArray | null;
    if (method === 'GET' && [...this.failing].some((suffix) => path.endsWith(suffix)))
      return err(500, 'XO_INTERNAL', 'temporarily unavailable');
    const studio = this.studio.handle(method, path, body as unknown as Record<string, unknown>, reply, err, {
      approvedIds: this.approvals,
      startDraftRun: (draft, plan, body) => {
        const denied = (plan['steps'] as Array<{ capabilityId: string }>).filter(
          (st) => !this.approvals.has(`${plan['compilationId']}:${st.capabilityId}`),
        );
        if (denied.length > 0)
          return reply(403, {
            error: {
              code: 'XO_RUNTIME_PERMISSION_DENIED',
              message: `capability "${denied[0]!.capabilityId}" is not approved for execution in workspace "ws_1"`,
              context: { denials: denied.map((x) => x.capabilityId) },
            },
          });
        const now = new Date().toISOString();
        const stepsPlan = plan['steps'] as Array<{ capabilityId: string; name: string; executionClass: string }>;
        const hitl = stepsPlan.findIndex((x) => x.executionClass === 'human_in_the_loop');
        const run = {
          workflowExecutionId: `wfx_${(++this.rn).toString(16).padStart(8, '0')}`,
          workspaceId: 'ws_1',
          identityId: 'sally',
          initiator: { kind: 'human', id: 'sally' },
          compilationId: plan['compilationId'],
          workflowId: `draft:${draft.definitionId}`,
          workflowName: draft.name,
          draft: { definitionId: draft.definitionId, revision: draft.revision, path: plan['path'], branches: plan['branches'] },
          revision: 2,
          status: hitl >= 0 ? 'waiting_for_human' : 'succeeded',
          input: (body['input'] as Record<string, unknown>) ?? {},
          steps: stepsPlan.map((x, i) => ({
            stepId: `${x.capabilityId}#${i}`,
            order: i,
            capabilityId: x.capabilityId,
            capabilityName: x.name,
            status: hitl < 0 || i < hitl ? 'succeeded' : i === hitl ? 'waiting_for_human' : 'pending',
            ...(hitl < 0 || i <= hitl ? { executionId: `exe_d${this.rn}_${i}` } : {}),
          })),
          currentStepIndex: hitl >= 0 ? hitl : null,
          ...(hitl >= 0
            ? {
                currentStepExecutionId: `exe_d${this.rn}_${hitl}`,
                pendingHumanTask: { stepIndex: hitl, executionId: `exe_d${this.rn}_${hitl}` },
              }
            : {}),
          completedStepExecutionIds: [],
          createdAt: now,
          updatedAt: now,
          ...(hitl < 0 ? { completedAt: now } : {}),
        };
        this.workflowRuns.push(run);
        return reply(202, run);
      },
    });
    if (studio !== undefined) return studio;

    // ---- registry (read-only): search needs a non-empty q; inspect returns the record plus its recorded benchmark runs
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/registry\/search\?q=(.*)$/))) {
      const q = decodeURIComponent(m[1]!).trim().toLowerCase();
      if (q === '') return err(400, 'XO_INVALID_ARGUMENT', 'query parameter "q" is required');
      return reply(200, {
        records: this.registryPackages.filter(
          (r) =>
            r.manifest.name.toLowerCase().includes(q) ||
            (r.manifest.capabilities ?? []).some((c: any) => `${c.name} ${c.description}`.toLowerCase().includes(q)),
        ),
      });
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/registry\/packages\/([^/]+)\/inspect$/))) {
      const record = this.registryPackages.find((r) => r.id === m![1]);
      if (!record) return err(404, 'XO_NOT_FOUND', `package "${m[1]}" was not found`);
      return reply(200, { record, benchmarkRuns: this.benchmarkRuns.filter((b) => b.packageId === record.id) });
    }

    // ---- workflow controls (real route/response shapes; the refusals mirror the platform's 412 reasons)
    const bd = body as unknown as Record<string, any>;
    const ctlMatch =
      /\/workspaces\/[^/]+\/workflow-controls(?:\/(pause|resume)|\/workflows\/([^/]+)\/(mode|limits|triggers|sign-off|shadow-reviews))?$/.exec(
        path,
      );
    if (ctlMatch !== null) {
      if (!this.supportsControls) return reply(404, { error: { code: 'XO_NOT_FOUND', message: 'no such route' } });
      const c = this.controls;
      const latest = this.compilations[this.compilations.length - 1];
      const rulesOk = ['cap_det', 'cap_hitl'].every((id) => this.approvals.has(`${latest?.compilationId}:${id}`));
      const practiced = () => this.workflowRuns.filter((r) => r.shadow !== undefined && r.status === 'succeeded');
      const view = () => {
        const today = this.workflowRuns.length;
        const cases = practiced()
          .slice(-10)
          .reverse()
          .map((r) => ({
            workflowExecutionId: r.workflowExecutionId,
            createdAt: r.createdAt,
            outcome: r.shadow.outcome ?? 'would_complete',
            ...(r.shadow.stepName !== undefined ? { stepName: r.shadow.stepName } : {}),
            ...(c.reviews[r.workflowExecutionId] !== undefined ? { judgement: c.reviews[r.workflowExecutionId] } : {}),
          }));
        const judged = cases.filter((k) => k.judgement !== undefined);
        const readiness = [
          { id: 'rules', ok: rulesOk, message: rulesOk ? 'Every rule is approved' : 'Some rules still need approval' },
          {
            id: 'runnable',
            ok: this.workflowExecutable,
            message: this.workflowExecutable ? 'The platform can run this' : 'The platform cannot run this yet',
          },
          {
            id: 'signed',
            ok: c.signOff !== undefined,
            message: c.signOff !== undefined ? 'This version is signed off' : 'Nobody has signed this version off yet',
          },
          { id: 'limits', ok: c.cap !== undefined, message: c.cap !== undefined ? `At most ${c.cap} runs a day` : 'No daily limit is set' },
          {
            id: 'practice',
            ok: practiced().length > 0,
            message: practiced().length > 0 ? `Practised on ${practiced().length} cases` : 'It has not practised on any case yet',
          },
        ];
        return {
          workflowId: 'wf_1',
          compilationId: latest?.compilationId,
          mode: c.mode,
          triggers: { manual: true, webhook: c.webhook, ...(c.schedule !== undefined ? { schedule: c.schedule } : {}) },
          limits: { ...(c.cap !== undefined ? { dailyRunCap: c.cap } : {}), runsToday: today },
          ...(c.signOff !== undefined ? { signOff: { ...c.signOff, current: true } } : {}),
          readiness,
          canGoLive: readiness.every((r) => r.ok),
          shadow: {
            runs: cases.length,
            wouldComplete: cases.filter((k) => k.outcome === 'would_complete').length,
            wouldEscalate: cases.filter((k) => k.outcome === 'would_escalate').length,
            reviewed: judged.length,
            agreed: judged.filter((k) => (k.judgement === 'automatic') === (k.outcome === 'would_complete')).length,
          },
          shadowCases: cases,
          revision: 1,
        };
      };
      const refuse = (message: string, reason = 'not_ready') =>
        reply(412, { error: { code: 'XO_PRECONDITION_FAILED', message, context: { reason } } });
      if (method === 'GET') {
        if (latest === undefined) return reply(200, { paused: c.paused, deployments: [] });
        return reply(200, { paused: c.paused, ...(c.reason !== undefined ? { reason: c.reason } : {}), deployments: [view()] });
      }
      if (ctlMatch[1] === 'pause') {
        c.paused = true;
        if (typeof bd.reason === 'string') c.reason = bd.reason;
        return reply(200, { paused: true, ...(c.reason !== undefined ? { reason: c.reason } : {}) });
      }
      if (ctlMatch[1] === 'resume') {
        c.paused = false;
        delete c.reason;
        return reply(200, { paused: false });
      }
      switch (ctlMatch[3]) {
        case 'mode': {
          const to = bd.mode as typeof c.mode;
          const v = view();
          const missing = (ids: string[]) => v.readiness.filter((r) => ids.includes(r.id) && !r.ok).map((r) => r.message);
          const need =
            to === 'shadow'
              ? missing(['rules', 'runnable'])
              : to === 'live'
                ? missing(['rules', 'runnable', 'signed', 'limits', 'practice'])
                : [];
          if (need.length > 0) return refuse(`It cannot move to ${to} yet: ${need.join('; ')}.`);
          c.mode = to;
          return reply(200, view());
        }
        case 'limits':
          if (bd.dailyRunCap === null) delete c.cap;
          else c.cap = bd.dailyRunCap;
          return reply(200, view());
        case 'triggers':
          if (typeof bd.webhook === 'boolean') c.webhook = bd.webhook;
          if (bd.schedule === null) delete c.schedule;
          else if (bd.schedule !== undefined)
            c.schedule = {
              everyMinutes: bd.schedule.everyMinutes,
              lastFiredAt: new Date().toISOString(),
              ...(bd.schedule.input !== undefined ? { input: bd.schedule.input } : {}),
            };
          return reply(200, view());
        case 'sign-off':
          if (!rulesOk || !this.workflowExecutable) return refuse('It cannot be signed off yet: Some rules still need approval.');
          c.signOff = { identityId: 'sally', displayName: 'Sally', at: new Date().toISOString() };
          return reply(200, view());
        case 'shadow-reviews':
          if (!practiced().some((r) => r.workflowExecutionId === bd.workflowExecutionId))
            return reply(404, { error: { code: 'XO_NOT_FOUND', message: 'practice run not found' } });
          c.reviews[bd.workflowExecutionId] = bd.judgement;
          return reply(200, view());
      }
    }

    // ---- workflows (real route/response shapes; checked live by scripts/live-smoke.mjs)
    if (method === 'GET' && path.endsWith('/workflows')) {
      const latest = this.compilations[this.compilations.length - 1];
      if (latest === undefined) return reply(200, { workflows: [] });
      return reply(200, {
        workflows: [
          {
            workflowId: 'wf_1',
            compilationId: latest.compilationId,
            sourceId: latest.sourceId,
            name: 'Record before payment → Review not covered',
            description: 'Candidate workflow deterministically composed from 2 discovered capabilities.',
            status: 'executable_candidate',
            executable: this.workflowExecutable,
            notExecutableReasons: this.workflowExecutable ? [] : ['ambiguous step order'],
            blockers: [],
            requiresHumanDecision: false,
            confidence: 0.45,
            gaps: [],
            steps: ['cap_det', 'cap_hitl'].map((id, order) => ({
              order,
              stepId: `${id}#${order}`,
              capabilityId: id,
              name: this.caps.find((c) => c.capabilityId === id)!.name,
              description: this.caps.find((c) => c.capabilityId === id)!.description,
            })),
          },
        ],
      });
    }
    if (method === 'GET' && path.endsWith('/workflow-executions'))
      return reply(200, { workflowExecutions: this.hideRunsFromList ? [] : this.workflowRuns });
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/workflow-executions\/([^/]+)$/))) {
      const run = this.workflowRuns.find((r) => r.workflowExecutionId === m![1]);
      return run ? reply(200, run) : err(404, 'XO_NOT_FOUND', `workflow execution "${m[1]}" was not found`);
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/([^/]+)\/workflows\/([^/]+)\/executions$/))) {
      const certificateId = (body as unknown as { certificateId?: string }).certificateId;
      if (this.requireCertificate && certificateId === undefined)
        return reply(409, {
          error: { code: 'XO_READINESS_CERTIFICATE_REQUIRED', message: 'this workspace requires a readiness certificate' },
        });
      if (this.irOnly && certificateId !== undefined)
        return reply(409, {
          error: {
            code: 'XO_WORKFLOW_REQUIRES_IR_RUNTIME',
            message: 'only the workflow runtime executes this definition',
            context: { definitionId: `gwf_${'0'.repeat(23)}1`, constructs: ['act'] },
          },
        });
      if (this.startBehavior === 'network_before') {
        // a retry (same key) may succeed once the failure clears; the test flips startBehavior back
        throw new TypeError('Failed to fetch');
      }
      const idemKey = headers['Idempotency-Key'];
      if (idemKey !== undefined) {
        const seen = this.startKeys.get(idemKey);
        if (seen !== undefined) {
          if (seen.compilationId !== body.compilationId || seen.workflowId !== m[2])
            return reply(409, {
              error: { code: 'XO_RUNTIME_SESSION_INVALID_STATE', message: 'key reused', context: { reason: 'idempotency_key_reused' } },
            });
          return reply(
            200,
            this.workflowRuns.find((r) => r.workflowExecutionId === seen.runId),
          );
        }
      }
      if (this.supportsControls) {
        const c = this.controls;
        const reason = c.paused
          ? 'workspace_paused'
          : c.mode === 'paused'
            ? 'workflow_paused'
            : c.cap !== undefined && this.workflowRuns.length >= c.cap
              ? 'daily_cap_reached'
              : undefined;
        if (reason !== undefined)
          return reply(412, { error: { code: 'XO_PRECONDITION_FAILED', message: `Start refused: ${reason}`, context: { reason } } });
      }
      const denials = ['cap_det', 'cap_hitl']
        .filter((id) => this.denyNextStart || !this.approvals.has(`${body.compilationId}:${id}`))
        .map((id) => `capability "${id}" is not approved for execution in workspace "${m![1]}"`);
      if (denials.length > 0) this.denyNextStart = false;
      if (denials.length > 0)
        return reply(403, { error: { code: 'XO_RUNTIME_PERMISSION_DENIED', message: denials[0], context: { denials } } });
      const now = new Date().toISOString();
      const run = {
        workflowExecutionId: `wfx_${(++this.rn).toString(16).padStart(8, '0')}`,
        workspaceId: m[1],
        identityId: 'sally',
        initiator: { kind: 'human', id: 'sally' },
        compilationId: body.compilationId,
        workflowId: m[2],
        workflowName: 'Record before payment → Review not covered',
        revision: 3,
        status: 'waiting_for_human',
        input: {},
        steps: [
          {
            stepId: 'cap_det#0',
            order: 0,
            capabilityId: 'cap_det',
            capabilityName: 'Record before payment',
            status: 'waiting_for_human',
            executionId: `exe_s0_${this.rn}`,
          },
          { stepId: 'cap_hitl#1', order: 1, capabilityId: 'cap_hitl', capabilityName: 'Review not covered', status: 'pending' },
        ],
        currentStepIndex: 0,
        currentStepExecutionId: `exe_s0_${this.rn}`,
        pendingHumanTask: { stepIndex: 0, executionId: `exe_s0_${this.rn}` },
        completedStepExecutionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      if (this.supportsControls && this.controls.mode === 'shadow') {
        // A practice run: carries out what XO can, stops before the first step that needs a person, asks nobody.
        Object.assign(run, {
          status: 'succeeded',
          currentStepIndex: null,
          completedAt: now,
          steps: [
            { stepId: 'cap_det#0', order: 0, capabilityId: 'cap_det', capabilityName: 'Record before payment', status: 'succeeded' },
            { stepId: 'cap_hitl#1', order: 1, capabilityId: 'cap_hitl', capabilityName: 'Review not covered', status: 'skipped' },
          ],
          shadow: { outcome: 'would_escalate', stepName: 'Review not covered' },
        });
        delete (run as Record<string, unknown>)['pendingHumanTask'];
        delete (run as Record<string, unknown>)['currentStepExecutionId'];
      }
      this.workflowRuns.push(run);
      if (idemKey !== undefined)
        this.startKeys.set(idemKey, { runId: run.workflowExecutionId, compilationId: body.compilationId, workflowId: m[2]! });
      if (this.startBehavior === 'network_after_create') throw new TypeError('Failed to fetch');
      return reply(201, run);
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/workflow-executions\/([^/]+)\/resume$/))) {
      if (this.resumeBehavior === 'network_before') throw new TypeError('Failed to fetch');
      const run = this.workflowRuns.find((r) => r.workflowExecutionId === m![1]);
      if (!run) return err(404, 'XO_NOT_FOUND', 'no such workflow execution');
      if (this.bumpRevisionBeforeResume) run.revision += 1;
      const b = body as unknown as {
        decision?: string;
        data?: Record<string, unknown>;
        expectedStepExecutionId?: string;
        expectedRevision?: number;
      };
      if (run.status === 'interrupted') {
        // mirrors the platform: recovery takes NO decision/data/step id; only the revision is checked
        if (b.decision !== undefined || b.data !== undefined)
          return reply(400, {
            error: {
              code: 'XO_INVALID_ARGUMENT',
              message: 'do not supply decision/data when resuming an interrupted workflow',
              context: { reason: 'no_pending_human_task' },
            },
          });
        if (b.expectedRevision !== undefined && b.expectedRevision !== run.revision)
          return reply(409, {
            error: { code: 'XO_RUNTIME_SESSION_INVALID_STATE', message: 'stale revision', context: { reason: 'stale_revision' } },
          });
        this.recoverRun(run);
        if (this.resumeBehavior === 'network_after_apply') throw new TypeError('Failed to fetch');
        return reply(200, run);
      }
      if (b.decision !== 'approve' && b.decision !== 'reject')
        return err(400, 'XO_INVALID_ARGUMENT', '"decision" must be one of: approve, reject');
      if (b.expectedStepExecutionId === undefined)
        return reply(400, {
          error: {
            code: 'XO_INVALID_ARGUMENT',
            message: 'expectedStepExecutionId is required',
            context: { reason: 'expected_step_execution_id_required' },
          },
        });
      if (run.status !== 'waiting_for_human')
        return reply(409, {
          error: {
            code: 'XO_RUNTIME_SESSION_INVALID_STATE',
            message: 'not resumable',
            context: { reason: run.status === 'succeeded' || run.status === 'rejected' ? 'terminal' : 'not_resumable' },
          },
        });
      if (b.expectedStepExecutionId !== run.currentStepExecutionId)
        return reply(409, {
          error: { code: 'XO_RUNTIME_SESSION_INVALID_STATE', message: 'stale step', context: { reason: 'stale_step_execution' } },
        });
      if (b.expectedRevision !== undefined && b.expectedRevision !== run.revision)
        return reply(409, {
          error: { code: 'XO_RUNTIME_SESSION_INVALID_STATE', message: 'stale revision', context: { reason: 'stale_revision' } },
        });
      if (b.data !== undefined && this.rejectDecisionData)
        return err(400, 'XO_INVALID_ARGUMENT', "decision data does not match this capability's schema");
      if (b.data !== undefined && JSON.stringify(b.data).length > 8192)
        return err(400, 'XO_INVALID_ARGUMENT', '"data" must be at most 8192 bytes serialized');
      this.applyDecision(run, b.decision, b.data);
      if (this.resumeBehavior === 'network_after_apply') throw new TypeError('Failed to fetch');
      return reply(200, run);
    }
    if (method === 'GET' && path === '/health') return reply(200, { status: 'ok' });
    if (method === 'GET' && path === '/openapi.json')
      return reply(200, {
        openapi: '3.0.3',
        info: { title: 'XO Platform API', version: '0.1.0' },
        paths: {
          '/health': { get: { summary: 'Liveness check', security: [] } },
          '/workspaces': { get: { summary: 'List workspaces' }, post: { summary: 'Create a workspace' } },
          '/workspaces/{workspaceId}/sources': { get: { summary: 'List sources' }, post: { summary: 'Upload a source' } },
        },
      });
    if (method === 'GET' && path === '/workspaces')
      return reply(200, { workspaces: this.workspaces.map((w) => ({ ...w, ...this.studio.workspaceMeta() })) });
    if (method === 'POST' && path === '/workspaces') {
      const w = { workspaceId: this.id('ws'), name: body.name ?? '', createdAt: new Date().toISOString() };
      this.workspaces.push(w);
      return reply(201, { ...w, ...this.studio.workspaceMeta() });
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/sources$/)))
      return reply(200, {
        sources: this.sources.map((s) => ({
          ...s,
          mediaType: 'application/pdf',
          digestSha256: 'ab'.repeat(32),
          createdAt: '2026-10-10T10:00:00Z',
        })),
      });
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/sources\?filename=(.+)$/))) {
      const s = { sourceId: this.id('src'), originalFilename: decodeURIComponent(m[1]!), byteSize: 1234 };
      this.sources.push(s);
      return reply(201, { ...s, mediaType: 'application/pdf', digestSha256: 'ab'.repeat(32), createdAt: '2026-10-10T10:00:00Z' });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/sources\/([^/]+)\/compile$/))) {
      const failing = this.failNextCompile;
      this.failNextCompile = undefined;
      const c = {
        compilationId: this.id('cmp'),
        sourceId: m[1]!,
        status: failing ? ('failed' as const) : ('succeeded' as const),
        createdAt: new Date().toISOString(),
        ...(failing ?? {}),
      };
      this.compilations.push(c);
      return reply(failing ? 200 : 201, { ...c, sourceDigestSha256: 'ab'.repeat(32), completedAt: c.createdAt });
    }
    if (method === 'GET' && path.endsWith('/compilations'))
      return reply(200, {
        compilations: this.compilations.map((c) => ({ ...c, sourceDigestSha256: 'ab'.repeat(32), completedAt: c.createdAt })),
      });
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/compilations\/([^/]+)\/capabilities$/))) {
      const cid = m[1]!;
      return reply(200, {
        compilationId: cid,
        capabilities: this.caps.map((c) => ({
          ...c,
          ...((this.publishContract && c.capabilityId === 'cap_det') || this.publishContractAll ? { inputContract: CONTRACT } : {}),
          contractId: c.capabilityId,
          provenance: [{ documentPath: 'src', pages: [2] }],
          approved: this.approvals.has(`${cid}:${c.capabilityId}`),
        })),
      });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/compilations\/([^/]+)\/capabilities\/([^/]+)\/approve$/))) {
      const target = this.caps.find((c) => c.capabilityId === m![2]);
      if (this.approveRefusal || target?.status === 'unresolved')
        return err(
          422,
          'XO_BINDING_UNRESOLVED',
          `capability "${m[2]}" cannot be approved: its binding status is "unresolved", so it cannot be carried out.`,
        );
      this.approvals.add(`${m[1]}:${m[2]}`);
      return reply(200, { compilationId: m[1], capabilityId: m[2], status: 'approved', approvedAt: new Date().toISOString() });
    }
    if (method === 'GET' && path.endsWith('/executions')) return reply(200, { executions: this.executions });
    if (method === 'POST' && path.endsWith('/executions')) {
      if (this.executeBehavior === 'unavailable') return err(501, 'XO_UNIMPLEMENTED', 'AI execution is disabled');
      if (this.executeBehavior === 'forbidden') return err(403, 'XO_RUNTIME_PERMISSION_DENIED', 'not allowed');
      if (!this.approvals.has(`${body.compilationId}:${body.capabilityId}`))
        return err(403, 'XO_RUNTIME_PERMISSION_DENIED', 'capability is not approved');
      const base = {
        executionId: this.id('exe'),
        compilationId: body.compilationId,
        capabilityId: body.capabilityId,
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        input: body.input,
        initiator: { kind: 'human', id: 'sally' },
      };
      const rec =
        this.executeBehavior === 'binding_unresolved'
          ? { ...base, status: 'failed', errorCode: 'XO_BINDING_UNRESOLVED', errorMessage: 'capability could not be bound' }
          : this.executeBehavior === 'invalid_input'
            ? {
                ...base,
                status: 'failed',
                errorCode: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
                errorMessage:
                  'input validation failed: claim: missing required property; lossadjuster_assessment: missing required property',
              }
            : this.executeBehavior === 'waiting_for_human'
              ? { ...base, status: 'waiting_for_human', output: { escalated: true }, humanTask: { status: 'pending' } }
              : { ...base, status: 'succeeded', output: { result: 'ok' } };
      this.executions.push(rec);
      return reply(rec.status === 'failed' ? 200 : 201, rec);
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/executions\/([^/]+)\/resolve$/))) {
      const e = this.executions.find((x) => x.executionId === m![1]);
      if (!e) return err(404, 'XO_NOT_FOUND', 'no such execution');
      const sd = (body as unknown as { data?: Record<string, unknown> }).data;
      if (sd !== undefined && JSON.stringify(sd).length > 8192)
        return err(400, 'XO_INVALID_ARGUMENT', '"data" must be at most 8192 bytes serialized');
      e.humanTask = {
        status: 'resolved',
        decision: body.decision,
        ...(sd !== undefined ? { decisionData: sd } : {}),
        resolverIdentityId: 'sally',
        resolvedAt: new Date().toISOString(),
      };
      e.status = body.decision === 'approve' ? 'succeeded' : 'rejected';
      return reply(200, e);
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/compilations\/([^/]+)\/generated-workflows$/))) {
      const wf = (body as unknown as { workflowId?: string }).workflowId;
      return reply(201, {
        definition: { definitionId: `gwf_${'0'.repeat(23)}1`, candidateWorkflowId: wf, compilationId: m[1] },
        selection: { status: 'explicit' },
      });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/([^/]+)\/readiness$/))) {
      this.certifyCalls += 1;
      const ready = this.certificateStatus === 'READY';
      return reply(201, {
        certificateId: `wrc_${'0'.repeat(23)}${this.certifyCalls}`,
        status: this.certificateStatus,
        scope: { compilationId: 'cmp_1', definitionId: m[1], candidateWorkflowId: 'wf_1', workflowName: 'Record before payment' },
        gates: [
          { id: 'source-quality', outcome: 'pass', findings: ['every source was read and can be relied on'] },
          {
            id: 'authorization',
            outcome: ready ? 'pass' : 'review',
            findings: ready ? ['every step is approved'] : ['"Review not covered": not approved for its current contract'],
          },
          ...(this.certificateStatus === 'BLOCKED'
            ? [{ id: 'capabilities', outcome: 'block', findings: ['"Pay out" bound: not bound'] }]
            : []),
        ],
        blockers: this.certificateStatus === 'BLOCKED' ? ['"Pay out" bound: not bound'] : [],
        reviewItems: ready ? [] : ['"Review not covered": not approved for its current contract'],
        conditions: [],
        issuedAt: new Date().toISOString(),
        digest: `sha256:${'a'.repeat(64)}`,
      });
    }
    // ---- UW-12b: the control surface (batch previews, approvals, the runtime inbox, cancel, reconcile)
    const items = [
      { index: 0, state: 'stops', reason: 'the reviewer must check the address', approvals: ['check'], actions: [] },
      ...[1, 2].map((i) => ({
        index: i,
        state: 'sends',
        approvals: [],
        actions: [
          {
            step: 'send',
            connector: 'mail',
            operation: 'send_certificate',
            sideEffect: 'irreversible',
            args: { to: `person${i}@example.org`, attachments: [{ filename: `cert-${i}.pdf`, sha256: `${i}`.repeat(64) }] },
          },
        ],
      })),
    ];
    const previewView = (p: (typeof this.previews)[number], q: string) => {
      const exceptionsOnly = /[?&]show=exceptions/.test(q);
      const shown = exceptionsOnly ? items.filter((i) => i.state === 'stops') : items;
      return {
        previewId: p.previewId,
        definitionId: p.definitionId,
        certificateId: p.certificateId,
        root: p.root,
        forEach: true,
        effects: true,
        counts: { sends: 2, no_effect: 0, stops: 1, not_exact: 0 },
        senders: [
          {
            connector: 'mail',
            provider: 'google',
            account: 'office@example.org',
            tier: 'native_api',
            tierExplanation: 'Sends through the Gmail API; XO can look up what was sent.',
          },
        ],
        createdBy: p.createdBy,
        createdAt: '2026-11-20T10:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        approvable: p.approval === undefined,
        ...(p.approval !== undefined ? { approval: p.approval } : {}),
        ...(p.items !== undefined
          ? {
              itemsSource: {
                ...p.items,
                role: 'per_person_documents',
                label: "each client's certificate",
                connectionName: 'Renewals',
                over: 'client_items',
                digests: [],
                changedSinceConfirmation: false,
                counts: { items: 3, excludedRows: 1, excludedDocuments: 0, loose: 0 },
                excludedRows: [{ row: 4, reason: 'no_document' }],
                excludedDocuments: [],
                looseRows: [],
              },
            }
          : {}),
        page: 1,
        pages: 1,
        total: shown.length,
        items: shown,
      };
    };
    if (method === 'GET' && /^\/workspaces\/[^/]+\/control\/inbox$/.test(path)) {
      return reply(200, {
        batches: this.previews
          .filter((p) => p.approval?.usedBy === undefined)
          .map((p) => ({
            definitionId: p.definitionId,
            workflowName: 'Send certificates',
            state: p.approval === undefined ? 'awaiting_approval' : 'ready_to_start',
            previewId: p.previewId,
            certificateId: p.certificateId,
            root: p.root,
            total: 3,
            counts: { sends: 2, no_effect: 0, stops: 1, not_exact: 0 },
            senders: [{ connector: 'mail', account: 'office@example.org' }],
            createdBy: p.createdBy,
            createdAt: '2026-11-20T10:00:00.000Z',
            expiresAt: '2030-01-01T00:00:00.000Z',
            preparedByYou: p.createdBy === 'sally',
            ...(p.approval !== undefined ? { approval: p.approval } : {}),
          })),
        steps: this.generatedRuns.flatMap((r) =>
          r.pendingApprovals.map((a) => ({
            definitionId: `gwf_${'0'.repeat(23)}1`,
            workflowName: 'Send certificates',
            runId: r.runId,
            approvalId: a.approvalId,
            step: a.step,
            summary: a.summary,
            proposedActions: ['mail.send_certificate'],
            requestedAt: '2026-11-20T10:00:00.000Z',
            expiresAt: a.expiresAt,
          })),
        ),
        attention: this.unknownEffects.map((e) => ({
          ...e,
          workflowName: 'Send certificates',
          operation: 'send_certificate',
          state: 'outcome_unknown',
          intentAt: '2026-11-20T10:00:00.000Z',
          detail: 'connection reset after the request was written',
        })),
        truncated: false,
      });
    }
    if (method === 'GET' && /^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/item-sources$/.test(path))
      return reply(200, this.itemSources);
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/([^/]+)\/previews$/))) {
      const given = (body as unknown as { items?: { connectionId: string; proposalId: string } }).items;
      const p = {
        previewId: `pvw_${String(this.previews.length + 1).padStart(24, '0')}`,
        definitionId: m[1]!,
        certificateId: String((body as unknown as { certificateId?: string }).certificateId),
        root: `sha256:${'r'.repeat(8)}${this.previews.length + 1}`,
        createdBy: this.previewPreparer,
        ...(given !== undefined ? { items: given } : {}),
      };
      this.previews.push(p);
      return reply(201, previewView(p, ''));
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/previews\/([^/?]+)(\?.*)?$/))) {
      const p = this.previews.find((x) => x.previewId === m![1]);
      return p === undefined ? err(404, 'XO_NOT_FOUND', 'no preview') : reply(200, previewView(p, m[2] ?? ''));
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/previews\/([^/]+)\/approve$/))) {
      const p = this.previews.find((x) => x.previewId === m![1]);
      if (p === undefined) return err(404, 'XO_NOT_FOUND', 'no preview');
      const refuse = (reason: string, message: string) =>
        reply(409, { error: { code: 'XO_BATCH_APPROVAL_REFUSED', message, context: { reason } } });
      if ((body as unknown as { root?: string }).root !== p.root)
        return refuse(
          'root_mismatch',
          'this is not the preview you were shown (its root differs); review the current preview and approve that',
        );
      if (this.separation && p.createdBy === 'sally')
        return refuse('separation_of_duties', 'someone other than the person who prepared this batch must approve it');
      p.approval = {
        approvalId: `bap_${String(this.previews.indexOf(p) + 1).padStart(24, '0')}`,
        reviewerId: 'sally',
        approvedAt: '2026-11-20T11:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
      };
      return reply(201, previewView(p, ''));
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/runs\/([^/]+)\/cancel$/))) {
      this.cancelled.push(m[1]!);
      const run = this.generatedRuns.find((x) => x.runId === m![1]);
      if (run !== undefined) {
        run.state = 'cancelled';
        run.pendingApprovals = [];
      }
      return reply(200, { runId: m[1], state: 'cancelled', pendingApprovals: [], decisions: [], cancelRecorded: true });
    }
    if (
      method === 'POST' &&
      (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/runs\/([^/]+)\/effects\/([^/]+)\/reconciliation$/))
    ) {
      const b = body as unknown as { decision: string; reason: string };
      this.reconciled.push({ runId: m[1]!, step: m[2]!, decision: b.decision, reason: b.reason });
      this.unknownEffects = this.unknownEffects.filter((e) => !(e.runId === m![1] && e.step === m![2]));
      return reply(200, { runId: m[1], effect: { step: m[2], state: b.decision } });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/([^/]+)\/runs$/))) {
      if ((body as unknown as { certificateId?: string }).certificateId === undefined)
        return reply(409, { error: { code: 'XO_READINESS_CERTIFICATE_REQUIRED', message: 'a certificate is required' } });
      const batchApprovalId = (body as unknown as { batchApprovalId?: string }).batchApprovalId;
      if (batchApprovalId !== undefined) {
        const p = this.previews.find((x) => x.approval?.approvalId === batchApprovalId);
        if (p === undefined) return err(404, 'XO_NOT_FOUND', 'no batch approval');
        const run = { runId: `run_${this.generatedRuns.length + 1}`, state: 'completed', pendingApprovals: [], decisions: [] };
        this.generatedRuns.push(run);
        p.approval!.usedBy = run.runId;
        return reply(201, run);
      }
      if (this.runApprovalRequired)
        return reply(409, {
          error: {
            code: 'XO_BATCH_APPROVAL_REQUIRED',
            message: 'this run can send or change things; it starts only from an approved batch',
          },
        });
      const run = {
        runId: `run_${this.generatedRuns.length + 1}`,
        state: 'waiting',
        pendingApprovals: [
          {
            approvalId: `apr_${this.generatedRuns.length + 1}`,
            step: 's1',
            summary: 'Record the settlement amount',
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        ],
        decisions: [],
      };
      this.generatedRuns.push(run);
      return reply(201, { ...run, certificateId: (body as unknown as { certificateId: string }).certificateId });
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/([^/]+)\/runs$/)))
      return reply(200, { runs: this.generatedRuns });
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/generated-workflows\/[^/]+\/runs\/([^/]+)\/approvals\/([^/]+)$/))) {
      const run = this.generatedRuns.find((x) => x.runId === m![1]);
      if (run === undefined) return err(404, 'XO_NOT_FOUND', 'no run');
      run.pendingApprovals = run.pendingApprovals.filter((a) => a.approvalId !== m![2]);
      run.state = (body as unknown as { action: string }).action === 'approve' ? 'completed' : 'escalated';
      run.decisions.push({
        step: 's1',
        reviewerId: 'sally',
        action: (body as unknown as { action: string }).action,
        signatureVerified: true,
      });
      return reply(200, run);
    }
    if (method === 'GET' && /^\/workspaces\/[^/]+\/connector-bindings$/.test(path)) {
      return reply(200, {
        revision: 1,
        bindings: this.emailTiers.map((t) => ({
          capability: 'sendEmail',
          connector: t.connector,
          kind: 'http',
          operation: 'send',
          sideEffect: 'write',
          adapter: 'email',
          adapterInstalled: true,
          emailTier: { tier: t.tier, lookup: t.lookup, explanation: t.explanation },
        })),
      });
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/readiness-certificates\/([^/]+)\/verify$/))) {
      return reply(200, {
        certificateId: m[1],
        status: this.certificateStatus,
        startAllowed: this.certificateCurrent && this.certificateStatus === 'READY',
        ...(this.certificateCurrent ? {} : { reasons: ['stale: the knowledge state changed since the certificate was issued'] }),
      });
    }
    return err(404, 'XO_NOT_FOUND', `no route ${method} ${path}`);
  };
}
