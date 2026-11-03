import { ConversationLayer } from '@xo/ai-core';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { PackageInstaller } from '@xo/package-sdk';
import { IntelligenceOrchestrator, type CapabilityPort, type HistoryTurn, type KnowledgePort, type Principal } from '@xo/intelligence';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspacePackagesStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { recordAudit } from '../audit/record.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { envProviderFactory, type ProviderFactory } from '../chat/model-provider.js';
import { usableModelChoices } from '../chat/usable-models.js';
import { FsConversationStore, MAX_CONVERSATIONS_PER_IDENTITY, type Conversation } from '../intelligence/conversation-store.js';
import { FsLearningPort } from '../intelligence/learning-store.js';
import { InstalledXoKnowledgePort } from '../intelligence/installed-xo-knowledge.js';

/**
 * XO Customer Chat — the intelligence experience. One conversation endpoint, no modes: each message is understood as
 * an ASK, DECIDE, DO or LEARN by the orchestrator (`@xo/intelligence`) and handled accordingly.
 *
 * This file is the experience boundary only. It owns authentication, ownership, persistence, model selection and
 * audit. It owns no AI logic (that is the orchestrator over `@xo/ai-core`) and no knowledge retrieval (that enters
 * through `KnowledgePort`, the C6 boundary). It is separate from `chat-routes.ts`, the Studio assistant.
 */

export interface IntelligenceRouteOptions {
  readonly providerFactory?: ProviderFactory;
  /** The C6 boundary, per workspace. Default: the interim adapter over XOs installed in the workspace (`InstalledXoKnowledgePort`). */
  readonly knowledge?: (workspace: WorkspaceRecord) => KnowledgePort;
  /** DO. Default: none — DO is reported unavailable. */
  readonly capabilities?: (workspace: WorkspaceRecord) => CapabilityPort | undefined;
}

const MAX_MESSAGE_CHARS = 8000;
const MAX_ATTACHED = 5;
const DEFAULT_TITLE = 'New conversation';

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

const summary = (c: Conversation) => ({
  conversationId: c.conversationId,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  messageCount: c.messages.length,
});

export function registerIntelligenceRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  options: IntelligenceRouteOptions = {},
): void {
  const providerFor = options.providerFactory ?? envProviderFactory();
  // One layer for the process, so circuit-breaker and rate-limit state is shared across requests, as it must be.
  const model = new ConversationLayer({ resolveProvider: (id) => providerFor(id) });
  const conversations = (w: WorkspaceRecord) => new FsConversationStore(workspaceStateStore(w, dataConfig), w.workspaceId);

  async function context(req: ApiRequest) {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const role = await requirePermission(req, workspace, 'read', dataConfig);
    const principal: Principal = { identityId: callerIdentityId(req), workspaceId: workspace.workspaceId, role };
    return { workspace, principal };
  }

  async function owned(req: ApiRequest, workspace: WorkspaceRecord): Promise<Conversation> {
    const id = req.params['conversationId'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing conversation id');
    const c = await conversations(workspace).get(id);
    if (c === undefined || c.ownerIdentityId !== callerIdentityId(req)) throw new NotFoundError(`conversation "${id}"`);
    return c;
  }

  const list = async (req: ApiRequest) => {
    const { workspace } = await context(req);
    return json(200, { conversations: (await conversations(workspace).listOwned(callerIdentityId(req))).map(summary) });
  };

  const create = async (req: ApiRequest) => {
    const { workspace } = await context(req);
    const store = conversations(workspace);
    if ((await store.listOwned(callerIdentityId(req))).length >= MAX_CONVERSATIONS_PER_IDENTITY) {
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `you have reached the limit of ${MAX_CONVERSATIONS_PER_IDENTITY} conversations; delete some first`,
      );
    }
    let title = DEFAULT_TITLE;
    if ((await req.rawBody()).length > 0) {
      const body = await req.json<{ title?: unknown }>();
      if (!body.ok) throw body.error;
      const t = body.value?.title;
      if (t !== undefined) {
        if (typeof t !== 'string' || t.trim().length === 0 || t.length > 120)
          throw new XoError(ErrorCode.INVALID_ARGUMENT, '"title", if present, must be 1-120 characters');
        title = t.trim();
      }
    }
    const c = await store.create(callerIdentityId(req), title, new Date());
    return json(201, { ...summary(c), messages: [] });
  };

  const get = async (req: ApiRequest) => {
    const { workspace } = await context(req);
    return json(200, await owned(req, workspace));
  };

  const remove = async (req: ApiRequest) => {
    const { workspace } = await context(req);
    const c = await owned(req, workspace);
    await conversations(workspace).delete(c.conversationId);
    return json(200, { deleted: c.conversationId });
  };

  const postTurn = async (req: ApiRequest) => {
    const { workspace, principal } = await context(req);
    const conversation = await owned(req, workspace);
    const body = await req.json<{ message?: unknown; attach?: unknown }>();
    if (!body.ok) throw body.error;
    const message = body.value?.message;
    const attach = body.value?.attach;
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_MESSAGE_CHARS) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `"message" must be a non-empty string of at most ${MAX_MESSAGE_CHARS} characters`);
    }

    let scope: string[] = [];
    if (attach !== undefined) {
      if (
        !Array.isArray(attach) ||
        attach.length > MAX_ATTACHED ||
        !attach.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200)
      ) {
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `"attach" must be an array of at most ${MAX_ATTACHED} installed XO names`);
      }
      scope = [...new Set(attach as string[])];
      const installed = await new PackageInstaller(workspacePackagesStore(workspace, dataConfig)).listInstalled();
      for (const name of scope) {
        if (!installed.some((i) => i.name === name))
          throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${name}" is not an installed XO in this workspace`);
      }
    }

    const stateStore = workspaceStateStore(workspace, dataConfig);
    const settings = await new FsSettingsStore(stateStore, workspace.workspaceId).get();
    const usable = usableModelChoices(settings, providerFor);

    const orchestrator = new IntelligenceOrchestrator({
      model,
      knowledge: options.knowledge?.(workspace) ?? new InstalledXoKnowledgePort(workspacePackagesStore(workspace, dataConfig)),
      ...(options.capabilities?.(workspace) !== undefined ? { capabilities: options.capabilities(workspace) as CapabilityPort } : {}),
      learning: new FsLearningPort(stateStore),
    });

    const history: HistoryTurn[] = conversation.messages.map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content }
        : {
            role: 'assistant',
            content: m.content,
            turnId: m.messageId,
            citedEvidenceIds: (m.result?.citations ?? []).map((c) => c.evidenceId),
          },
    );

    const turn = await orchestrator.handle({
      principal,
      message,
      history,
      ...(scope.length > 0 ? { scope } : {}),
      modelCandidates: usable.map((c) => ({ providerId: c.provider, model: c.model })),
      traceId: `${conversation.conversationId}`,
    });
    if (!turn.ok) {
      // The layer's error text is already free of provider detail; still, only a fixed message is relayed.
      throw new XoError(
        ErrorCode.AI_ALL_PROVIDERS_FAILED,
        `the model request failed (tried: ${usable.map((c) => c.provider).join(', ')}); nothing was saved`,
      );
    }
    const result = turn.value;

    const retitle =
      conversation.title === DEFAULT_TITLE && conversation.messages.length === 0
        ? message.trim().replace(/\s+/g, ' ').slice(0, 60)
        : undefined;
    const saved = await conversations(workspace).append(
      conversation.conversationId,
      [
        { role: 'user', content: message.trim() },
        { role: 'assistant', content: result.text, result },
      ],
      new Date(),
      retitle,
    );
    if (saved === undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this conversation is full; start a new one');

    await recordAudit(req, workspace, dataConfig, {
      event: 'intelligence.turn',
      result: 'succeeded',
      target: { kind: 'conversation', id: conversation.conversationId },
      // Metadata only: neither the question nor the answer is written to the audit log.
      detail: {
        route: result.route,
        confidence: result.confidence,
        grounded: result.grounded,
        citations: result.citations.length,
        evidenceConsidered: result.evidenceConsidered,
        notices: result.notices.map((n) => n.code).join(','),
        proposed: result.proposal?.capabilityId ?? '',
        modelCalls: result.usage.calls.length,
        costUsd: Number(result.usage.totalCostUsd.toFixed(6)),
        providers: [...new Set(result.usage.calls.map((c) => c.provider))].join(','),
      },
    });
    const [userMessage, assistantMessage] = saved.messages.slice(-2);
    return json(201, { conversationId: saved.conversationId, title: saved.title, userMessage, assistantMessage });
  };

  const feedback = async (req: ApiRequest) => {
    const { workspace, principal } = await context(req);
    const conversation = await owned(req, workspace);
    const target = conversation.messages.find((m) => m.messageId === req.params['messageId'] && m.role === 'assistant');
    if (target === undefined) throw new NotFoundError(`message "${req.params['messageId'] ?? ''}"`);
    const body = await req.json<{ rating?: unknown; comment?: unknown }>();
    if (!body.ok) throw body.error;
    const { rating, comment } = body.value ?? {};
    if (rating !== 'helpful' && rating !== 'unhelpful')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"rating" must be "helpful" or "unhelpful"');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"comment", if present, must be a string of at most 2000 characters');
    const record = await new FsLearningPort(workspaceStateStore(workspace, dataConfig)).record({
      principal,
      kind: 'feedback',
      statement: `${rating}${typeof comment === 'string' && comment.trim().length > 0 ? `: ${comment.trim()}` : ''}`,
      aboutTurnId: target.messageId,
      aboutEvidenceIds: (target.result?.citations ?? []).map((c) => c.evidenceId),
    });
    await recordAudit(req, workspace, dataConfig, {
      event: 'intelligence.feedback',
      result: 'succeeded',
      target: { kind: 'conversation', id: conversation.conversationId },
      detail: { rating, learningEventId: record.eventId },
    });
    return json(201, { eventId: record.eventId, status: 'pending_review' });
  };

  const base = '/workspaces/:workspaceId/intelligence/conversations';
  router.get(base, guarded(list));
  router.post(base, guarded(create));
  router.get(`${base}/:conversationId`, guarded(get));
  router.delete(`${base}/:conversationId`, guarded(remove));
  router.post(`${base}/:conversationId/turns`, guarded(postTurn));
  router.post(`${base}/:conversationId/messages/:messageId/feedback`, guarded(feedback));
}
