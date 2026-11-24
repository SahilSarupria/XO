import { ConversationLayer, resolveResidency, type ResidencyPolicy } from '@xo/ai-core';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { IntelligenceOrchestrator, type KnowledgePort, type Principal, type TurnResult } from '@xo/intelligence';
import { PackageInstaller } from '@xo/package-sdk';
import type { PermissionManager } from '@xo/permissions';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  hasPermission,
  requireOwnedWorkspace,
  requirePermission,
  workspaceCompilationsStore,
  workspacePackagesStore,
  workspaceSourcesStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { recordAudit } from '../audit/record.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { envProviderFactory, guardedFactory, type ProviderFactory } from '../chat/model-provider.js';
import { usableModelChoices } from '../chat/usable-models.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsLearningPort } from '../intelligence/learning-store.js';
import { CONVERSATION_ID_PATTERN, FsConversationStore } from '../intelligence/conversation-store.js';
import { workspaceWorkflowEntitiesStore } from '../workflow-entities/entity-store.js';
import { generatedRunPort, type WorkflowRunView } from '../workflow-entities/run-port.js';
import { WORKFLOW_ID, currentVersion, deriveLifecycle, type WorkflowEntity, type WorkflowLifecycle } from '../workflow-entities/entity.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { workspaceCertificatesStore } from './readiness-routes.js';
import { compileSourceById } from './source-compilation-routes.js';
import { defaultKnowledgePort } from './intelligence-routes.js';
import type { RunnerDeps } from './generated-run-routes.js';
import { ASK_PLACES, PLACE_LABEL, type AskAnswer, type AskContext, type AskPlace, type Interpretation } from '../ask/ask-types.js';
import { interpret, navigateByWords, runLookupByWords } from '../ask/interpret.js';

/**
 * S1-3b — `POST /workspaces/{ws}/ask`: the Ask box that works on every screen.
 *
 * One request (free text plus where the person is), exactly one typed answer (`../ask/ask-types.ts`). The model's only part is to
 * CHOOSE what kind of request it is; it never acts. Everything it names (a workflow, a place) is checked against this workspace and
 * this caller, and the answer is built here. The route starts nothing, approves nothing and changes nothing: a prepared start is
 * confirmed in Studio through the existing gated routes, so the readiness certificate, approvals and effect authorisation are
 * exactly what they were.
 *
 * Privacy: the audit entry records the kind of answer and counts, never the text typed or the reply. Model calls pass the same
 * residency and egress guards as every other AI route, and a caller's permissions bound every answer (a reviewer cannot be offered
 * a start they could not make).
 */

export interface AskRouteOptions {
  readonly providerFactory?: ProviderFactory;
  readonly residency?: ResidencyPolicy;
  /** Test seam / alternative deployments: the knowledge answers come from. Default: the same as customer chat. */
  readonly knowledge?: (workspace: WorkspaceRecord) => KnowledgePort;
}

const MAX_TEXT_CHARS = 2000;
const MAX_RUN_SCAN = 50;
const ID_SHAPE = /^[A-Za-z0-9_.-]{1,120}$/;

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

const bad = (message: string) => new XoError(ErrorCode.INVALID_ARGUMENT, message);

function readContext(raw: unknown): AskContext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('"context" must be an object with a "place"');
  const c = raw as Record<string, unknown>;
  const unknown = Object.keys(c).filter((k) => !['place', 'workflowId', 'runId', 'documentId'].includes(k));
  if (unknown.length > 0) throw bad(`unknown context field(s): ${unknown.join(', ')}`);
  if (typeof c['place'] !== 'string' || !(ASK_PLACES as readonly string[]).includes(c['place']))
    throw bad(`context.place must be one of: ${ASK_PLACES.join(', ')}`);
  const id = (k: string): string | undefined => {
    const v = c[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !ID_SHAPE.test(v)) throw bad(`context.${k} is not a valid id`);
    return v;
  };
  const workflowId = id('workflowId');
  const runId = id('runId');
  const documentId = id('documentId');
  return {
    place: c['place'] as AskPlace,
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(documentId !== undefined ? { documentId } : {}),
  };
}

const cannot = (reason: string, whatWouldHelp: string): AskAnswer => ({ kind: 'cannot', reason, whatWouldHelp });

/** Why a workflow cannot be started yet, in the words a person uses. */
function notReadyWhy(lifecycle: WorkflowLifecycle, certificateOk: boolean): string | undefined {
  switch (lifecycle) {
    case 'archived':
      return 'It is archived, so it cannot start.';
    case 'paused':
      return 'It is paused, so it cannot start. Resume it first.';
    case 'running':
      return 'It already has a run under way.';
    case 'awaiting_approval':
      return 'A run of it is waiting for a person to approve.';
    case 'needs_attention':
      return 'Its last run needs attention before it can start again.';
    case 'draft':
      return 'It has not passed the check before starting yet. Open it and run that check first.';
    default:
      return certificateOk ? undefined : 'Its check before starting is out of date. Open it and run that check again.';
  }
}

export function registerAskRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  permissionManager: PermissionManager,
  options: AskRouteOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const residency = options.residency ?? resolveResidency(process.env);
  const providerFor = guardedFactory(options.providerFactory ?? envProviderFactory(process.env, residency), residency);
  // One layer for the process, so circuit-breaker and rate-limit state is shared across requests, as it must be.
  const model = new ConversationLayer({ resolveProvider: (id) => providerFor(id) });
  const deps: RunnerDeps = { workspaceStore, dataConfig, permissionManager, env, audit };

  const entitiesOf = (w: WorkspaceRecord) => workspaceWorkflowEntitiesStore(dataConfig.dataRootDir, w.workspaceId);

  async function facts(w: WorkspaceRecord) {
    const [certificates, controls] = await Promise.all([
      workspaceCertificatesStore(w, dataConfig).list(),
      new FsControlsStore(workspaceStateStore(w, dataConfig), w.workspaceId).getControls(),
    ]);
    const latest = new Map<string, string>();
    const issued = new Map<string, string>();
    for (const c of certificates) {
      const id = c.scope.definitionId;
      if (id === undefined) continue;
      if ((issued.get(id) ?? '') < c.issuedAt) {
        issued.set(id, c.issuedAt);
        latest.set(id, c.status);
      }
    }
    return { certificateStatus: latest, workspacePaused: controls.paused };
  }

  // ------------------------------------------------------------------------------------------------------ the five kinds

  async function answerFromKnowledge(
    req: ApiRequest,
    workspace: WorkspaceRecord,
    text: string,
    context: AskContext,
    workflow: WorkflowEntity | undefined,
    usable: readonly { provider: string; model: string }[],
    scope: readonly string[],
    save: ((result: TurnResult) => Promise<void>) | undefined,
  ): Promise<AskAnswer> {
    const role = await requirePermission(req, workspace, 'read', dataConfig);
    const principal: Principal = {
      identityId: callerIdentityId(req),
      workspaceId: workspace.workspaceId,
      role,
      ...(req.principal !== undefined ? { authenticated: req.principal } : {}),
    };
    const stateStore = workspaceStateStore(workspace, dataConfig);
    const orchestrator = new IntelligenceOrchestrator({
      model,
      knowledge: options.knowledge?.(workspace) ?? defaultKnowledgePort(workspace, dataConfig),
      learning: new FsLearningPort(stateStore),
    });
    // Where the person is shapes the question, so "why did this stop?" on a workflow is about that workflow.
    const framed = workflow !== undefined ? `About the workflow named "${workflow.name}": ${text}` : text;
    const turn = await orchestrator.handle({
      principal,
      message: framed,
      ...(scope.length > 0 ? { scope } : {}),
      modelCandidates: usable.map((c) => ({ providerId: c.provider, model: c.model })),
      traceId: `ask-${context.place}`,
    });
    if (!turn.ok)
      return cannot('XO could not reach its model just now, so it could not answer.', 'Try again in a moment. Nothing was changed.');
    const r = turn.value;
    // A question asked inside a saved conversation is saved in it, so earlier chats, ratings and reopening work as they always did.
    await save?.(r);
    return {
      kind: 'answer',
      text: r.text,
      grounded: r.grounded,
      confidence: r.confidence,
      citations: r.citations.map((c) => ({
        index: c.index,
        sourceName: c.sourceName,
        ...(c.sourceType !== undefined ? { sourceType: c.sourceType } : {}),
        excerpt: c.excerpt,
        ...(c.asOf !== undefined ? { asOf: c.asOf } : {}),
      })),
      notices: r.notices.map((n) => n.message),
    };
  }

  async function analyse(req: ApiRequest, workspace: WorkspaceRecord, documentId: string): Promise<AskAnswer> {
    if (!(await hasPermission(req, workspace, 'author')))
      return cannot(
        'Reading a new document needs a role that can add sources.',
        'Ask someone who can add sources to read it, or ask for that role.',
      );
    const source = await new FsSourceStore(workspaceSourcesStore(workspace, dataConfig)).get(documentId);
    if (!source.ok) throw source.error;
    const fileName = source.value.originalFilename;
    const record = await compileSourceById(req, workspace, dataConfig, documentId);
    if (record.status !== 'succeeded')
      return {
        kind: 'analyse',
        documentId,
        fileName,
        status: 'failed',
        summary: `XO could not read “${fileName}”. Nothing was added.`,
        found: { documentKinds: [], stepCount: 0 },
        canUseAsSource: false,
      };
    const capabilities = await new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)).getCapabilities(
      record.compilationId,
    );
    const stepCount = capabilities.ok ? capabilities.value.length : 0;
    const kinds = (record.sourceReport?.kindProposals ?? []).slice(0, 3).map((k) => ({
      kind: k.kind,
      label: k.label,
      evidence: k.evidence.slice(0, 3).map((e) => ({ matched: e.matched, where: e.where })),
    }));
    const cov = record.sourceReport?.coverage;
    const parts = [`XO read “${fileName}”.`];
    if (kinds[0] !== undefined) parts.push(`It looks like: ${kinds[0].label}. Check that before you rely on it.`);
    parts.push(
      stepCount === 0 ? 'It found no steps to carry out.' : `It found ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} to carry out.`,
    );
    if (cov !== undefined && cov.extractedPages + cov.ocrPages < cov.totalPages)
      parts.push(`${cov.totalPages - cov.extractedPages - cov.ocrPages} of ${cov.totalPages} pages could not be read.`);
    return {
      kind: 'analyse',
      documentId,
      fileName,
      status: 'succeeded',
      compilationId: record.compilationId,
      summary: parts.join(' '),
      found: {
        documentKinds: kinds,
        stepCount,
        ...(cov !== undefined ? { pages: { total: cov.totalPages, read: cov.extractedPages + cov.ocrPages } } : {}),
      },
      canUseAsSource: true,
    };
  }

  async function prepareStart(
    req: ApiRequest,
    workspace: WorkspaceRecord,
    entities: readonly WorkflowEntity[],
    chosen: WorkflowEntity | undefined,
    goal: string,
  ): Promise<AskAnswer> {
    if (!(await hasPermission(req, workspace, 'author')))
      return cannot(
        'Starting work needs a role that can run workflows. Yours can look, not start.',
        'Ask someone who can run workflows to start it, or ask for that role.',
      );
    if (chosen !== undefined) {
      const f = await facts(workspace);
      const runs = await generatedRunPort(deps, workspace).runsOf(chosen);
      const cur = currentVersion(chosen);
      const cert = f.certificateStatus.get(cur.definition.definitionId);
      const certificateOk = cert === 'READY' || cert === 'READY_WITH_CONDITIONS';
      const lifecycle = deriveLifecycle({
        entity: chosen,
        runs,
        workspacePaused: f.workspacePaused,
        ...(cert !== undefined ? { currentCertificateStatus: cert } : {}),
      });
      const why = notReadyWhy(lifecycle, certificateOk);
      return {
        kind: 'start',
        summary:
          why === undefined
            ? `“${chosen.name}” is ready. Open it to see what it will do, then start it.`
            : `“${chosen.name}” cannot start yet.`,
        workflow: { workflowId: chosen.workflowId, name: chosen.name },
        ready: why === undefined,
        ...(why !== undefined ? { why } : {}),
      };
    }
    // No such workflow: it can be created from a goal, but only from sources XO has already read and only if there is no doubt which.
    if (goal.length === 0) return cannot('XO could not tell which workflow you mean.', 'Name the workflow, or open Work and choose one.');
    void entities;
    const compilations = await new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)).list();
    const done = compilations.ok ? compilations.value.filter((c) => c.status === 'succeeded') : [];
    if (done.length === 0)
      return cannot('There is no workflow like that yet, and no source has been read.', 'Add a document in Sources first. Then ask again.');
    if (done.length > 1)
      return cannot(
        'There is no workflow like that yet, and more than one source could build it.',
        'Open Work and create it from the source you want.',
      );
    const only = done[0]!;
    return {
      kind: 'start',
      summary: 'There is no workflow like that yet. XO can create one from your source. Creating it does not start anything.',
      ready: false,
      why: 'It has to be created, checked and approved before it can start.',
      proposal: { goal, compilationId: only.compilationId },
    };
  }

  /** "Show the run that failed": the newest matching run across the workspace's workflows, found from the engine's own record. */
  async function findRun(workspace: WorkspaceRecord, entities: readonly WorkflowEntity[], failedOnly: boolean): Promise<AskAnswer> {
    const port = generatedRunPort(deps, workspace);
    const found: { run: WorkflowRunView; workflowId: string }[] = [];
    for (const e of entities.slice(0, MAX_RUN_SCAN)) {
      for (const r of await port.runsOf(e)) {
        if (failedOnly && !(r.state === 'failed' || r.batchOutcome === 'none_completed')) continue;
        found.push({ run: r, workflowId: e.workflowId });
      }
    }
    found.sort((a, b) => (a.run.startedAt < b.run.startedAt ? 1 : a.run.startedAt > b.run.startedAt ? -1 : 0));
    const top = found[0];
    if (top === undefined) return cannot(failedOnly ? 'No run has failed.' : 'There are no runs yet.', 'Open Activity to see every run.');
    return {
      kind: 'navigate',
      place: 'work',
      label: failedOnly ? 'The most recent run that did not complete' : 'The most recent run',
      workflowId: top.workflowId,
      runId: top.run.runId,
    };
  }

  // -------------------------------------------------------------------------------------------------------------- route

  async function ask(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const parsed = await req.json<Record<string, unknown>>();
    if (!parsed.ok) throw parsed.error;
    const body = parsed.value ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
    const extra = Object.keys(body).filter((k) => !['text', 'context', 'conversationId', 'attach'].includes(k));
    if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(', ')}`);
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (body['text'] !== undefined && typeof body['text'] !== 'string') throw bad('"text" must be a string');
    if (text.length > MAX_TEXT_CHARS) throw bad(`"text" must be at most ${MAX_TEXT_CHARS} characters`);
    const context = readContext(body['context']);
    if (text.length === 0 && context.documentId === undefined) throw bad('"text" is required (or a document to look at)');

    // An optional saved conversation (the caller's own, or a 404) and installed XOs to focus on, checked as chat's turns check them.
    const conversations = new FsConversationStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId);
    let conversationId: string | undefined;
    let firstMessage = false;
    if (body['conversationId'] !== undefined) {
      const id = body['conversationId'];
      if (typeof id !== 'string' || !CONVERSATION_ID_PATTERN.test(id)) throw bad('"conversationId" must be a conversation id (cnv_…)');
      const c = await conversations.get(id);
      if (c === undefined || c.ownerIdentityId !== callerIdentityId(req)) throw new NotFoundError(`conversation "${id}"`);
      conversationId = c.conversationId;
      firstMessage = c.messages.length === 0 && c.title === 'New conversation';
    }
    let scope: string[] = [];
    if (body['attach'] !== undefined) {
      const attach = body['attach'];
      if (!Array.isArray(attach) || attach.length > 5 || !attach.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200))
        throw bad('"attach" must be an array of at most 5 installed XO names');
      scope = [...new Set(attach as string[])];
      const installed = await new PackageInstaller(workspacePackagesStore(workspace, dataConfig)).listInstalled();
      for (const name of scope)
        if (!installed.some((i) => i.name === name)) throw bad(`"${name}" is not an installed XO in this workspace`);
    }
    const save =
      conversationId === undefined
        ? undefined
        : async (result: TurnResult): Promise<void> => {
            const saved = await conversations.append(
              conversationId,
              [
                { role: 'user', content: text },
                { role: 'assistant', content: result.text, result },
              ],
              new Date(),
              firstMessage ? text.replace(/\s+/g, ' ').slice(0, 60) : undefined,
            );
            if (saved === undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this conversation is full; start a new one');
          };

    // Ids from the screen are checked here. A document that is not this workspace's is a 404; a workflow that is not
    // (or no longer) is simply not "the one you are looking at".
    if (context.documentId !== undefined) {
      const found = await new FsSourceStore(workspaceSourcesStore(workspace, dataConfig)).get(context.documentId);
      if (!found.ok) throw new NotFoundError(`document "${context.documentId}"`);
    }
    const entities = (await entitiesOf(workspace).list()).filter((e) => !e.archived);
    const here =
      context.workflowId !== undefined && WORKFLOW_ID.test(context.workflowId)
        ? entities.find((e) => e.workflowId === context.workflowId)
        : undefined;

    let answer: AskAnswer;
    let usedModel = false;
    const place = navigateByWords(text);
    const runLookup = place === undefined ? runLookupByWords(text) : undefined;
    if (place !== undefined) {
      answer = { kind: 'navigate', place, label: PLACE_LABEL[place] };
    } else if (runLookup !== undefined) {
      answer = await findRun(workspace, entities, runLookup.failedOnly);
    } else if (text.length === 0 && context.documentId !== undefined) {
      answer = await analyse(req, workspace, context.documentId);
    } else {
      // Everything else needs the model to choose a kind. No model chosen, or none usable, is said in words, not thrown.
      let usable: ReturnType<typeof usableModelChoices> | undefined;
      let unusableWhy = '';
      try {
        const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
        usable = usableModelChoices(settings, providerFor);
      } catch (e) {
        unusableWhy = e instanceof XoError ? e.message : 'No model is available.';
      }
      if (usable === undefined) {
        answer = cannot(
          'XO has no model it can use here, so it can only open places in Studio for now.',
          `${unusableWhy}`.slice(0, 300) || 'Choose a model in Settings.',
        );
      } else {
        usedModel = true;
        const candidates = usable.map((c) => ({ providerId: c.provider, model: c.model }));
        const picked = await interpret(
          model,
          {
            text,
            context,
            documentAttached: context.documentId !== undefined,
            workflows: entities.map((e) => ({ workflowId: e.workflowId, name: e.name })),
          },
          candidates,
          `ask-${context.place}`,
        );
        if (!picked.ok) answer = cannot('XO could not reach its model just now.', 'Try again in a moment. Nothing was changed.');
        else answer = await build(req, workspace, picked.value, text, context, here, entities, usable, scope, save);
      }
    }

    await recordAudit(req, workspace, dataConfig, {
      event: 'ask.answered',
      result: 'succeeded',
      // Kinds, places and counts only: the text typed and the reply are never written to the audit log.
      detail: {
        kind: answer.kind,
        place: context.place,
        modelUsed: usedModel,
        inputChars: text.length,
        ...(answer.kind === 'answer' ? { grounded: answer.grounded, citations: answer.citations.length } : {}),
        ...(answer.kind === 'start' ? { ready: answer.ready } : {}),
      },
    });
    return json(200, { answer });
  }

  /** The model chose; the server decides. Each branch re-checks what the choice names. */
  async function build(
    req: ApiRequest,
    workspace: WorkspaceRecord,
    choice: Interpretation,
    text: string,
    context: AskContext,
    here: WorkflowEntity | undefined,
    entities: readonly WorkflowEntity[],
    usable: readonly { provider: string; model: string }[],
    scope: readonly string[],
    save: ((result: TurnResult) => Promise<void>) | undefined,
  ): Promise<AskAnswer> {
    switch (choice.kind) {
      case 'answer':
        return answerFromKnowledge(req, workspace, text, context, here, usable, scope, save);
      case 'analyse':
        return context.documentId === undefined
          ? cannot('There is no document to look at.', 'Drop a document into the Ask box, then ask again.')
          : analyse(req, workspace, context.documentId);
      case 'start': {
        const named = entities.find((e) => e.workflowId === choice.workflowId);
        // An id the model named that is not a workflow here is a confusion, not a request to create one.
        if (choice.workflowId.length > 0 && named === undefined)
          return cannot('XO could not find that workflow.', 'Open Work to find it, or name it again.');
        return prepareStart(req, workspace, entities, named ?? (choice.goal.length === 0 ? here : undefined), choice.goal || text);
      }
      case 'navigate': {
        const target = entities.find((e) => e.workflowId === choice.workflowId);
        if (target !== undefined) return { kind: 'navigate', place: 'work', label: target.name, workflowId: target.workflowId };
        if ((ASK_PLACES as readonly string[]).includes(choice.place)) {
          const p = choice.place as AskPlace;
          return { kind: 'navigate', place: p, label: PLACE_LABEL[p] };
        }
        return cannot('XO could not tell where you want to go.', `Name a place: ${ASK_PLACES.map((p) => PLACE_LABEL[p]).join(', ')}.`);
      }
      case 'cannot':
        return cannot(
          choice.reason.length > 0 ? choice.reason : 'XO cannot do that from here.',
          'Use the screen for it, or ask someone with the right role.',
        );
    }
  }

  router.post('/workspaces/:workspaceId/ask', guarded(ask));
}
