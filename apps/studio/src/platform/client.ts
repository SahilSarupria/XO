import {
  parseConnectionAnswer,
  parseConnectionList,
  parseConnectionOptions,
  parseConsent,
  parseDriveAccounts,
  parseDriveFolders,
  type DriveAccount,
  type DriveFolder,
  type DriveProvider,
  type Pairing,
  type SourceConnectionDetail,
  type SourceConnectionOptions,
  type SourceConnectionSummary,
} from './wire-sources';
import {
  parseWorkflowChanges,
  parseWorkflowDetail,
  parseWorkflowPage,
  parseWorkspaceRunPage,
  type WorkspaceRunPage,
  parseWorkflowReply,
  type WorkflowChangeView,
  type WorkflowDetailView,
  type WorkflowLifecycle,
  type WorkflowPage,
} from './wire-workflows';
import type { AuthResult } from '../auth/oidc';
import { parseAskReply, type AskAnswer, type AskContext } from './wire-ask';
import {
  parseCertificateCheck,
  parseEmailTiers,
  parseGeneratedRun,
  parseGeneratedRunList,
  type GeneratedRunView,
  parseGeneratedWorkflowReply,
  parseReadinessCertificate,
  type CertificateCheck,
  type EmailTierLine,
  type ReadinessCertificateView,
} from './wire-readiness';
import {
  parseBatchPreview,
  parseControlInbox,
  parseItemSources,
  parseStanding,
  parseStandingList,
  parseStandingStart,
  type BatchPreviewView,
  type ControlInbox,
  type ItemSourcesView,
  type StandingStart,
  type StandingView,
} from './wire-control';
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
  parseWorkflowControl,
  parseWorkflowControls,
  parsePauseState,
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
  type WorkflowControl,
  type WorkflowControls,
  type WorkflowMode,
  type WorkflowRun,
  type Workspace,
  type WorkspaceRole,
  str,
  obj,
  num,
} from './wire';
import {
  parseDecisionAck,
  parseDecisions,
  parseReview,
  parseSearch,
  type DecisionSummary,
  type KnowledgeEnvelope,
  type ReviewData,
  type SearchData,
} from './wire-knowledge';
import {
  parseChangeSet,
  parseChangeSetPreview,
  parseChangeSets,
  parseKnowledgeConflicts,
  parseKnowledgeHead,
  parseKnowledgeHits,
  parseKnowledgePacks,
  parseKnowledgeRecords,
  parseKnowledgeStates,
  parseVerify,
} from './wire-xo-knowledge';
import {
  parseEmergencyStops,
  parseInboxChanges,
  parseObservations,
  parseRunEvidence,
  parseRunOutputs,
  parseStopList,
} from './wire-control';
import {
  parseActionResult,
  parseCatalog,
  parseConnectCapabilities,
  parseConnectDashboard,
  parseConnectSource,
  parseConnectSourceList,
  parseFolderPreview,
  parseRemovalPreview,
  parseRemovalResult,
  parseItemRemovalResult,
  type ItemRemovalResult,
  parseSourceFolderView,
  type SourceFolderView,
  type ActionResult,
  type AddSourceEntry,
  type ConnectCapabilities,
  type ConnectDashboard,
  type ConnectSource,
  type FolderPreview,
  type RemovalPreview,
  type RemovalResult,
} from './wire-connect';
import {
  parseAnalysis,
  parseAuditPage,
  parseAuditVerification,
  parseCapabilityPreview,
  parseChatList,
  parseChatReply,
  parseChatSummaryBody,
  parseChatThread,
  parseDraft,
  parseDraftList,
  parseInboxDetail,
  parseInboxList,
  parseInfoRequest,
  parseInstalled,
  parseInstalls,
  parseLibraryDetail,
  parseLibraryList,
  parseMemberEnvelope,
  parseMemberList,
  parseNotificationFeed,
  parseRegions,
  parseRuntimeStatus,
  parseSettingsView,
  parseNodeKinds,
  parseTestCase,
  parseTestCaseBatch,
  parseTestCaseHistory,
  parseTestCaseList,
  parseTestCaseRun,
  type NodeKindSupport,
  type TestCase,
  type TestCaseBatch,
  type TestCaseDraft,
  type TestCaseRun,
  type AuditPage,
  type AuditVerification,
  type CapabilityPreview,
  type ChatReply,
  type ChatSummary,
  type ChatThreadFull,
  type DraftAnalysis,
  type DraftEdge,
  type DraftNode,
  type InboxDetail,
  type InboxList,
  type InfoRequest,
  type Install,
  type LibraryDetail,
  type LibraryList,
  type Member,
  type MemberList,
  type NotificationFeed,
  type Region,
  type RuntimeStatus,
  type SettingsView,
  type WorkflowDraft,
  type WorkflowDraftSummary,
} from './wire-studio';

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
  /** Test seam: how the client waits between upload retries. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * UW-3 — files larger than this are sent as a resumable upload: verified chunks that carry on from the server's offset after a dropped
 * connection, instead of starting the whole file again (the usual case on a phone network). Smaller files use one request.
 */
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
/** Consecutive failed attempts at one chunk before the upload gives up (the session stays resumable on the server for a day). */
const UPLOAD_MAX_ATTEMPTS = 6;

/** Extensions the API accepts at upload (apps/api/src/sources/source.ts SUPPORTED_EXTENSIONS). */
export const SUPPORTED_UPLOAD_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.eml',
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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: XoClientOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    init?: { body?: BodyInit; contentType?: string; headers?: Readonly<Record<string, string>>; raw?: boolean; anonymous?: boolean },
  ): Promise<Result<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init?.anonymous !== true) {
      const token = await this.bearer();
      if (!token.ok) {
        return fail({
          kind: token.failure.kind === 'network' ? 'network' : 'unauthenticated',
          message:
            token.failure.kind === 'network' ? 'Could not reach the sign-in service to refresh your session.' : token.failure.message,
        });
      }
      headers['Authorization'] = `Bearer ${token.value}`;
    }
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
      return ok(parse(init?.raw === true ? text : body));
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

  // ---- platform description (read-only; public routes on the platform)
  getHealth(): Promise<Result<{ readonly status: string }>> {
    return this.call('GET', '/health', parseHealth);
  }
  getApiDescription(): Promise<Result<ApiDescription>> {
    return this.call('GET', '/openapi.json', parseApiDescription);
  }
  /** S1-3: the API's version and which optional parts it offers. No credential is sent (the route needs none). */
  getVersion(): Promise<Result<PlatformVersion>> {
    return this.call('GET', '/version', parsePlatformVersion, { anonymous: true });
  }
  /** S1-3: an error report with no content in it (see platform/errorReport.ts; the server strips it again). */
  reportClientError(report: ClientErrorReport): Promise<Result<void>> {
    return this.call('POST', '/client-errors', () => undefined, this.json(report));
  }

  // ---- Connect (C7). Contract: packages/connect/docs/HTTP_CONTRACT.md. Every action is decided again by the server; these only call it.
  /** Keyword search (C6 does not interpret questions). Results are the caller's visible scope only. */
  knowledgeSearch(q: string, limit?: number): Promise<Result<KnowledgeEnvelope<SearchData>>> {
    const qs = new URLSearchParams({ q, ...(limit !== undefined ? { limit: String(limit) } : {}) });
    return this.call('GET', `/connect/knowledge?${qs.toString()}`, parseSearch);
  }
  knowledgeSelect(
    select: 'entities' | 'relationships' | 'claims' | 'conflicts' | 'documents',
    limit?: number,
  ): Promise<Result<KnowledgeEnvelope<SearchData>>> {
    const qs = new URLSearchParams({ select, ...(limit !== undefined ? { limit: String(limit) } : {}) });
    return this.call('GET', `/connect/knowledge?${qs.toString()}`, parseSearch);
  }
  /** A human review decision. The server (C6) decides whether this caller may; Studio only offers it to callers with the review capability. */
  knowledgeResolveConflict(
    conflictId: string,
    winner: string | number | boolean,
  ): Promise<Result<{ decisionId: string; operationId: string }>> {
    return this.call(
      'POST',
      '/connect/knowledge/review/decisions',
      parseDecisionAck,
      this.json({ action: 'resolve_conflict', conflictId, winner }),
    );
  }
  knowledgeRevokeDecision(decisionId: string): Promise<Result<{ decisionId: string; operationId: string }>> {
    return this.call('POST', '/connect/knowledge/review/decisions', parseDecisionAck, this.json({ action: 'revoke_decision', decisionId }));
  }
  knowledgeDecisions(): Promise<Result<DecisionSummary[]>> {
    return this.call('GET', '/connect/knowledge/review/decisions', parseDecisions);
  }
  knowledgeReview(): Promise<Result<KnowledgeEnvelope<ReviewData>>> {
    return this.call('GET', '/connect/knowledge/review', parseReview);
  }
  connectCatalog(): Promise<Result<AddSourceEntry[]>> {
    return this.call('GET', '/connect/catalog', parseCatalog);
  }
  connectDashboard(): Promise<Result<ConnectDashboard>> {
    return this.call('GET', '/connect/dashboard', parseConnectDashboard);
  }
  connectCapabilities(): Promise<Result<ConnectCapabilities>> {
    return this.call('GET', '/connect/capabilities', parseConnectCapabilities);
  }
  connectSources(): Promise<Result<ConnectSource[]>> {
    return this.call('GET', '/connect/sources', parseConnectSourceList);
  }
  connectSource(id: string): Promise<Result<ConnectSource>> {
    return this.call('GET', `/connect/sources/${encodeURIComponent(id)}`, (b) => parseConnectSource(b));
  }
  connectSourceFolder(id: string): Promise<Result<SourceFolderView>> {
    return this.call('GET', `/connect/sources/${encodeURIComponent(id)}/folder`, parseSourceFolderView);
  }
  connectPreviewFolder(root: string, excludedNames?: readonly string[]): Promise<Result<FolderPreview>> {
    return this.call(
      'POST',
      '/connect/local-folders/preview',
      parseFolderPreview,
      this.json({ root, ...(excludedNames !== undefined ? { excludedNames } : {}) }),
    );
  }
  connectFolder(root: string, includeKeys: readonly string[], excludedNames?: readonly string[]): Promise<Result<ActionResult>> {
    return this.call(
      'POST',
      '/connect/local-folders',
      parseActionResult,
      this.json({ root, includeKeys, ...(excludedNames !== undefined ? { excludedNames } : {}) }),
    );
  }
  connectSelection(id: string, includeKeys: readonly string[], excludedNames?: readonly string[]): Promise<Result<ActionResult>> {
    return this.call(
      'POST',
      `/connect/sources/${encodeURIComponent(id)}/selection`,
      parseActionResult,
      this.json({ includeKeys, ...(excludedNames !== undefined ? { excludedNames } : {}) }),
    );
  }
  connectRead(id: string): Promise<Result<ActionResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/read`, parseActionResult, this.json({}));
  }
  connectCheck(id: string): Promise<Result<ActionResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/check`, parseActionResult, this.json({}));
  }
  connectDisconnect(id: string): Promise<Result<ActionResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/disconnect`, parseActionResult, this.json({}));
  }
  connectReconnect(id: string): Promise<Result<ActionResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/reconnect`, parseActionResult, this.json({}));
  }
  connectRemovalPreview(id: string): Promise<Result<RemovalPreview>> {
    return this.call('GET', `/connect/sources/${encodeURIComponent(id)}/removal`, parseRemovalPreview);
  }
  connectRemoveLearned(id: string, keys: readonly string[]): Promise<Result<ItemRemovalResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/items/remove`, parseItemRemovalResult, this.json({ keys }));
  }
  connectRemove(id: string): Promise<Result<RemovalResult>> {
    return this.call('POST', `/connect/sources/${encodeURIComponent(id)}/remove`, parseRemovalResult, this.json({}));
  }

  // ---- workspaces
  listWorkspaces(): Promise<Result<Workspace[]>> {
    return this.call('GET', '/workspaces', parseWorkspaceList);
  }
  createWorkspace(name: string, options: { kind?: 'team' | 'personal'; region?: string } = {}): Promise<Result<Workspace>> {
    return this.call('POST', '/workspaces', (b) => parseWorkspace(b), this.json({ name, ...options }));
  }
  listRegions(): Promise<Result<Region[]>> {
    return this.call('GET', '/regions', parseRegions);
  }

  // ---- members and roles
  listMembers(ws: string): Promise<Result<MemberList>> {
    return this.call('GET', `/workspaces/${enc(ws)}/members`, parseMemberList);
  }
  addMember(ws: string, input: { identityId: string; role: WorkspaceRole; displayName?: string; email?: string }): Promise<Result<Member>> {
    return this.call('POST', `/workspaces/${enc(ws)}/members`, parseMemberEnvelope, this.json(input));
  }
  changeMemberRole(ws: string, identityId: string, role: WorkspaceRole): Promise<Result<Member>> {
    return this.call('PATCH', `/workspaces/${enc(ws)}/members/${enc(identityId)}`, parseMemberEnvelope, this.json({ role }));
  }
  removeMember(ws: string, identityId: string): Promise<Result<{ removed: string }>> {
    return this.call('DELETE', `/workspaces/${enc(ws)}/members/${enc(identityId)}`, (b) => ({
      removed: String((b as { removed?: unknown })?.removed ?? identityId),
    }));
  }

  // ---- audit log
  listAudit(
    ws: string,
    q: { event?: string; result?: string; since?: string; limit?: number; before?: number } = {},
  ): Promise<Result<AuditPage>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.call('GET', `/workspaces/${enc(ws)}/audit/events${qs === '' ? '' : `?${qs}`}`, parseAuditPage);
  }
  verifyAudit(ws: string): Promise<Result<AuditVerification>> {
    return this.call('GET', `/workspaces/${enc(ws)}/audit/verify`, parseAuditVerification);
  }
  /** The exported bytes exactly as the server produced them (JSON evidence pack or CSV): never re-serialized here. */
  exportAudit(ws: string, format: 'json' | 'csv'): Promise<Result<string>> {
    return this.call('GET', `/workspaces/${enc(ws)}/audit/export?format=${format}`, (b) => String(b), { raw: true });
  }

  // ---- settings and runtime status
  getSettings(ws: string): Promise<Result<SettingsView>> {
    return this.call('GET', `/workspaces/${enc(ws)}/settings`, parseSettingsView);
  }
  updateSettings(ws: string, patch: Record<string, unknown>): Promise<Result<SettingsView>> {
    return this.call('PUT', `/workspaces/${enc(ws)}/settings`, parseSettingsView, this.json(patch));
  }
  getRuntimeStatus(ws: string): Promise<Result<RuntimeStatus>> {
    return this.call('GET', `/workspaces/${enc(ws)}/runtime/status`, parseRuntimeStatus);
  }

  // ---- notifications
  listNotifications(ws: string): Promise<Result<NotificationFeed>> {
    return this.call('GET', `/workspaces/${enc(ws)}/notifications`, parseNotificationFeed);
  }
  markNotificationsRead(ws: string, throughSeq: number): Promise<Result<{ readThroughSeq: number }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/notifications/read`,
      (b) => ({ readThroughSeq: Number((b as { readThroughSeq?: unknown })?.readThroughSeq) }),
      this.json({ throughSeq }),
    );
  }

  // ---- inbox
  listInbox(ws: string, state?: 'needs_review' | 'done'): Promise<Result<InboxList>> {
    return this.call('GET', `/workspaces/${enc(ws)}/inbox${state !== undefined ? `?state=${state}` : ''}`, parseInboxList);
  }
  getInboxItem(ws: string, executionId: string): Promise<Result<InboxDetail>> {
    return this.call('GET', `/workspaces/${enc(ws)}/inbox/${enc(executionId)}`, parseInboxDetail);
  }
  requestMoreInfo(ws: string, executionId: string, question: string): Promise<Result<InfoRequest>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/inbox/${enc(executionId)}/info-requests`,
      (b) => parseInfoRequest(b),
      this.json({ question }),
    );
  }
  answerInfoRequest(ws: string, executionId: string, requestId: string, answer: string): Promise<Result<InfoRequest>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/inbox/${enc(executionId)}/info-requests/${enc(requestId)}/answer`,
      (b) => parseInfoRequest(b),
      this.json({ answer }),
    );
  }

  // ---- library
  listLibrary(ws: string, q: { q?: string; scope?: 'all' | 'installed' | 'mine' } = {}): Promise<Result<LibraryList>> {
    const params = new URLSearchParams();
    if (q.q !== undefined && q.q.trim() !== '') params.set('q', q.q.trim());
    if (q.scope !== undefined) params.set('scope', q.scope);
    const qs = params.toString();
    return this.call('GET', `/workspaces/${enc(ws)}/library${qs === '' ? '' : `?${qs}`}`, parseLibraryList);
  }
  getLibraryPackage(ws: string, packageId: string): Promise<Result<LibraryDetail>> {
    return this.call('GET', `/workspaces/${enc(ws)}/library/packages/${enc(packageId)}`, parseLibraryDetail);
  }
  listInstalls(ws: string): Promise<Result<Install[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/library/installs`, parseInstalls);
  }
  installPackage(ws: string, packageId: string): Promise<Result<Install>> {
    return this.call('POST', `/workspaces/${enc(ws)}/library/installs`, parseInstalled, this.json({ packageId }));
  }
  uninstallPackage(ws: string, name: string, version: string): Promise<Result<{ uninstalled: string }>> {
    return this.call('DELETE', `/workspaces/${enc(ws)}/library/installs/${enc(name)}/${enc(version)}`, (b) => ({
      uninstalled: String((b as { uninstalled?: unknown })?.uninstalled ?? `${name}@${version}`),
    }));
  }

  // ---- sources: link import
  importSourceFromUrl(ws: string, url: string, filename?: string): Promise<Result<Source>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/sources/import`,
      (b) => parseSource(b),
      this.json({ url, ...(filename !== undefined ? { filename } : {}) }),
    );
  }

  // ---- chat: the intelligence conversation (persisted, private to the caller). XO works out whether a message is an
  // ASK, DECIDE, DO or LEARN; the person never picks a mode.
  listChats(ws: string): Promise<Result<ChatSummary[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/intelligence/conversations`, parseChatList);
  }
  createChat(ws: string, title?: string): Promise<Result<ChatSummary>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/intelligence/conversations`,
      parseChatSummaryBody,
      this.json(title !== undefined ? { title } : {}),
    );
  }
  getChat(ws: string, threadId: string): Promise<Result<ChatThreadFull>> {
    return this.call('GET', `/workspaces/${enc(ws)}/intelligence/conversations/${enc(threadId)}`, parseChatThread);
  }
  deleteChat(ws: string, threadId: string): Promise<Result<{ deleted: string }>> {
    return this.call('DELETE', `/workspaces/${enc(ws)}/intelligence/conversations/${enc(threadId)}`, (b) => ({
      deleted: String((b as { deleted?: unknown })?.deleted ?? threadId),
    }));
  }
  sendChatMessage(ws: string, threadId: string, content: string, attach: readonly string[] = []): Promise<Result<ChatReply>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/intelligence/conversations/${enc(threadId)}/turns`,
      parseChatReply,
      this.json({ message: content, ...(attach.length > 0 ? { attach } : {}) }),
    );
  }
  /**
   * S1-3b — the Ask box: free text plus where the person is, one typed answer back. It starts, approves and changes nothing; a
   * "start" answer is a prepared start that Studio confirms through the normal gated routes. With `conversationId` (the caller's own),
   * an answer is saved in that conversation exactly like a chat turn.
   */
  ask(
    ws: string,
    text: string,
    context: AskContext,
    options: { readonly conversationId?: string; readonly attach?: readonly string[] } = {},
  ): Promise<Result<AskAnswer>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/ask`,
      parseAskReply,
      this.json({
        text,
        context,
        ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
        ...(options.attach !== undefined && options.attach.length > 0 ? { attach: options.attach } : {}),
      }),
    );
  }
  /** Rate an answer. Filed for review; it does not change any answer. */
  rateChatMessage(
    ws: string,
    threadId: string,
    messageId: string,
    rating: 'helpful' | 'unhelpful',
    comment?: string,
  ): Promise<Result<{ eventId: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/intelligence/conversations/${enc(threadId)}/messages/${enc(messageId)}/feedback`,
      (b) => ({ eventId: str((b as { eventId?: unknown })?.eventId, 'eventId') }),
      this.json({ rating, ...(comment !== undefined && comment.trim() !== '' ? { comment } : {}) }),
    );
  }

  // ---- workflow drafts (saved graphs). Saving, validating and running a supported draft are real; the platform decides what is runnable.
  listDrafts(ws: string): Promise<Result<WorkflowDraftSummary[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-definitions`, parseDraftList);
  }
  getDraft(ws: string, definitionId: string): Promise<Result<WorkflowDraft>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-definitions/${enc(definitionId)}`, parseDraft);
  }
  createDraft(
    ws: string,
    draft: { name: string; nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  ): Promise<Result<WorkflowDraft>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-definitions`, parseDraft, this.json(draft));
  }
  /** `expectedRevision` is the revision the editor loaded; a newer saved draft is refused with a `stale_revision` problem and kept. */
  saveDraft(
    ws: string,
    definitionId: string,
    draft: { name: string; nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; expectedRevision: number },
  ): Promise<Result<WorkflowDraft>> {
    return this.call('PUT', `/workspaces/${enc(ws)}/workflow-definitions/${enc(definitionId)}`, parseDraft, this.json(draft));
  }
  deleteDraft(ws: string, definitionId: string): Promise<Result<{ deleted: string }>> {
    return this.call('DELETE', `/workspaces/${enc(ws)}/workflow-definitions/${enc(definitionId)}`, (b) => ({
      deleted: String((b as { deleted?: unknown })?.deleted ?? definitionId),
    }));
  }
  validateDraft(
    ws: string,
    draft: { name: string; nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  ): Promise<Result<DraftAnalysis>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-definitions/validate`, (b) => parseAnalysis(b), this.json(draft));
  }

  /** Which node kinds (and variants) the platform can run, with the reason for each it cannot. The editor offers only what is supported. */
  getNodeKinds(ws: string): Promise<Result<NodeKindSupport[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-definitions/node-kinds`, parseNodeKinds);
  }
  // ---- saved test cases (per capability). Pass/fail is the platform's verdict on a real, approval-gated execution.
  private casesPath(ws: string, compilationId: string, capabilityId: string): string {
    return `/workspaces/${enc(ws)}/compilations/${enc(compilationId)}/capabilities/${enc(capabilityId)}`;
  }
  listTestCases(ws: string, compilationId: string, capabilityId: string): Promise<Result<TestCase[]>> {
    return this.call('GET', `${this.casesPath(ws, compilationId, capabilityId)}/test-cases`, parseTestCaseList);
  }
  createTestCase(ws: string, compilationId: string, capabilityId: string, draft: TestCaseDraft): Promise<Result<TestCase>> {
    return this.call('POST', `${this.casesPath(ws, compilationId, capabilityId)}/test-cases`, (b) => parseTestCase(b), this.json(draft));
  }
  /** `expectedRevision` is the revision the form loaded; a newer saved case is refused (stale_revision) and kept. */
  updateTestCase(
    ws: string,
    compilationId: string,
    capabilityId: string,
    caseId: string,
    draft: TestCaseDraft & { expectedRevision: number },
  ): Promise<Result<TestCase>> {
    return this.call(
      'PUT',
      `${this.casesPath(ws, compilationId, capabilityId)}/test-cases/${enc(caseId)}`,
      (b) => parseTestCase(b),
      this.json(draft),
    );
  }
  deleteTestCase(ws: string, compilationId: string, capabilityId: string, caseId: string): Promise<Result<{ deleted: boolean }>> {
    return this.call('DELETE', `${this.casesPath(ws, compilationId, capabilityId)}/test-cases/${enc(caseId)}`, (b) => ({
      deleted: (b as { deleted?: unknown })?.deleted === true,
    }));
  }
  runTestCase(ws: string, compilationId: string, capabilityId: string, caseId: string): Promise<Result<TestCaseRun>> {
    return this.call('POST', `${this.casesPath(ws, compilationId, capabilityId)}/test-cases/${enc(caseId)}/runs`, (b) =>
      parseTestCaseRun(b),
    );
  }
  /** Runs every saved case of the capability, or just `caseIds`. Sequential real executions. */
  runTestCases(ws: string, compilationId: string, capabilityId: string, caseIds?: readonly string[]): Promise<Result<TestCaseBatch>> {
    return this.call(
      'POST',
      `${this.casesPath(ws, compilationId, capabilityId)}/test-case-runs`,
      parseTestCaseBatch,
      caseIds !== undefined ? this.json({ caseIds }) : undefined,
    );
  }
  testCaseHistory(ws: string, compilationId: string, capabilityId: string, caseId: string): Promise<Result<TestCaseRun[]>> {
    return this.call('GET', `${this.casesPath(ws, compilationId, capabilityId)}/test-cases/${enc(caseId)}/runs`, parseTestCaseHistory);
  }

  // ---- capability preview (no execution, no record, no approval). A Test Run is the ordinary createExecution above.
  previewCapability(ws: string, compilationId: string, capabilityId: string, input: unknown): Promise<Result<CapabilityPreview>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/compilations/${enc(compilationId)}/capabilities/${enc(capabilityId)}/preview`,
      parseCapabilityPreview,
      this.json({ input }),
    );
  }

  // ---- sources (context)
  listSources(ws: string): Promise<Result<Source[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/sources`, parseSourceList);
  }
  async uploadSource(ws: string, file: File, onProgress?: (sentBytes: number, totalBytes: number) => void): Promise<Result<Source>> {
    const buf = await readBytes(file);
    if (buf.byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES) return this.uploadResumable(ws, file, buf, onProgress);
    return this.call('POST', `/workspaces/${enc(ws)}/sources?filename=${encodeURIComponent(file.name)}`, (b) => parseSource(b), {
      body: buf,
      ...(file.type.length > 0 ? { contentType: file.type } : {}),
    });
  }

  /**
   * UW-3 — chunked upload that resumes from the server's offset. A network failure or a server error waits and retries (asking the
   * server where it got to first, since a chunk may have arrived even though its response did not); a refusal (bad type, bad file,
   * checksum mismatch) stops at once. The file's SHA-256 is declared up front, so the server verifies what it assembled.
   */
  private async uploadResumable(
    ws: string,
    file: File,
    buffer: ArrayBuffer,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
  ): Promise<Result<Source>> {
    const base = `/workspaces/${enc(ws)}/uploads`;
    const bytes = new Uint8Array(buffer);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const opened = await this.call('POST', base, parseUploadSession, {
      ...this.json({ filename: file.name, size: bytes.byteLength, sha256, ...(file.type.length > 0 ? { mediaType: file.type } : {}) }),
    });
    if (!opened.ok) return opened;
    const session = opened.value;
    let offset = session.offset;
    let attempts = 0;
    const transient = (kind: ProblemKind) => kind === 'network' || kind === 'server' || kind === 'unavailable';
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + Math.min(UPLOAD_CHUNK_BYTES, session.maxChunkBytes), bytes.byteLength);
      const sent = await this.call('PUT', `${base}/${enc(session.uploadId)}?offset=${offset}`, parseUploadSession, {
        body: bytes.slice(offset, end),
        contentType: 'application/octet-stream',
      });
      if (sent.ok) {
        offset = sent.value.offset;
        attempts = 0;
        onProgress?.(offset, bytes.byteLength);
        continue;
      }
      const offsetMoved = sent.problem.status === 412;
      if (!offsetMoved && !transient(sent.problem.kind)) return sent;
      if (!offsetMoved && ++attempts >= UPLOAD_MAX_ATTEMPTS) return sent;
      if (!offsetMoved) await this.sleep(Math.min(30_000, 500 * 2 ** (attempts - 1)));
      const where = await this.call('GET', `${base}/${enc(session.uploadId)}`, parseUploadSession);
      if (where.ok) offset = where.value.offset;
      else if (!transient(where.problem.kind)) return where;
    }
    return this.call('POST', `${base}/${enc(session.uploadId)}/complete`, (b) => parseSource(b));
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
  // ---- workflow controls (mode, triggers, limit, sign-off, pause). The platform decides; these just ask.
  getWorkflowControls(ws: string): Promise<Result<WorkflowControls>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-controls`, parseWorkflowControls);
  }
  /**
   * PX-8: the pre-start proof for one workflow. Generates the workflow's definition (named explicitly, so no goal guessing)
   * and asks the platform for a readiness certificate; the platform recomputes everything and decides the status.
   */
  async certifyWorkflow(ws: string, compilationId: string, workflowId: string, goal: string): Promise<Result<ReadinessCertificateView>> {
    const gen = await this.call(
      'POST',
      `/workspaces/${enc(ws)}/compilations/${enc(compilationId)}/generated-workflows`,
      parseGeneratedWorkflowReply,
      this.json({ goal: { text: goal }, workflowId }),
    );
    if (!gen.ok) return gen;
    if (gen.value.definitionId === undefined)
      return fail({ kind: 'rejected', message: gen.value.question ?? 'The goal did not select a workflow.' });
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(gen.value.definitionId)}/readiness`,
      (b) => parseReadinessCertificate(b),
      this.json({}),
    );
  }
  /**
   * ADR 0031 — starts a certified generated workflow on the Workflow IR runtime (the only path for definitions with
   * connector actions, waits, branches, undo steps, loops or extraction). The certificate is always required there.
   */
  startGeneratedRun(
    ws: string,
    definitionId: string,
    certificateId: string,
    input: Readonly<Record<string, unknown>> = {},
    idempotencyKey?: string,
  ): Promise<Result<GeneratedRunView>> {
    return this.call('POST', `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs`, (b) => parseGeneratedRun(b), {
      ...this.json({ input, certificateId }),
      ...(idempotencyKey !== undefined ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  listGeneratedRuns(ws: string, definitionId: string): Promise<Result<GeneratedRunView[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs`, parseGeneratedRunList);
  }
  /** A reviewer's decision on a waiting step of a generated run; the platform signs it as theirs. */
  decideGeneratedApproval(
    ws: string,
    definitionId: string,
    runId: string,
    approvalId: string,
    action: 'approve' | 'reject',
    comment?: string,
  ): Promise<Result<GeneratedRunView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/approvals/${enc(approvalId)}`,
      (b) => parseGeneratedRun(b),
      this.json({ action, ...(comment !== undefined ? { comment } : {}) }),
    );
  }
  // ---- UW-12b (ADR 0047): the control surface. The platform decides every action again; Studio only shows and asks.
  /** Everything on the workflow runtime waiting for a person: batches to approve or start, steps to decide, calls to reconcile. */
  controlInbox(ws: string): Promise<Result<ControlInbox>> {
    return this.call('GET', `/workspaces/${enc(ws)}/control/inbox`, parseControlInbox);
  }
  /** UW-8: prepares a batch preview (author role). Nothing is sent; the same gates as a start apply. */
  prepareBatchPreview(
    ws: string,
    definitionId: string,
    certificateId: string,
    input: Readonly<Record<string, unknown>> = {},
    /** V1-1 (ADR 0049): build the items from this confirmed list or pairing. */
    items?: { readonly connectionId: string; readonly proposalId: string },
  ): Promise<Result<BatchPreviewView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/previews`,
      (b) => parseBatchPreview(b),
      this.json({ input, certificateId, ...(items !== undefined ? { items } : {}) }),
    );
  }
  /** V1-1: the confirmed lists and pairings a once-per-item workflow can take its items from. */
  itemSources(ws: string, definitionId: string): Promise<Result<ItemSourcesView>> {
    return this.call('GET', `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/item-sources`, (b) => parseItemSources(b));
  }
  /** One page of a preview, exceptions first (or only the exceptions). */
  getBatchPreview(
    ws: string,
    definitionId: string,
    previewId: string,
    q: { readonly page?: number; readonly exceptionsOnly?: boolean } = {},
  ): Promise<Result<BatchPreviewView>> {
    const params = new URLSearchParams();
    if (q.page !== undefined) params.set('page', String(q.page));
    if (q.exceptionsOnly === true) params.set('show', 'exceptions');
    const qs = params.toString();
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/previews/${enc(previewId)}${qs.length > 0 ? `?${qs}` : ''}`,
      (b) => parseBatchPreview(b),
    );
  }
  /** A reviewer approves the preview they were shown, named by its root; the platform refuses any other root. */
  approveBatchPreview(
    ws: string,
    definitionId: string,
    previewId: string,
    root: string,
    presignSteps: readonly string[] = [],
  ): Promise<Result<BatchPreviewView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/previews/${enc(previewId)}/approve`,
      (b) => parseBatchPreview(b),
      this.json(presignSteps.length > 0 ? { root, presignSteps } : { root }),
    );
  }
  // ---- UW-16c (ADR 0051): standing approvals. The platform decides every action again (role, recent sign-in, who proposed, the digest shown).
  /** Proposes a standing approval (author role). It prepares a sample of today's items; someone else approves it. */
  proposeStandingApproval(
    ws: string,
    body: {
      readonly definitionId: string;
      readonly certificateId: string;
      readonly items?: { readonly connectionId: string; readonly proposalId: string };
      readonly limits: {
        readonly maxItemsPerRun: number;
        readonly maxItemsPerPeriod: number;
        readonly maxRunsPerPeriod: number;
        readonly period: 'day' | 'week' | 'month';
        readonly maxExcludedRows?: number;
      };
      readonly mayVary?: readonly { readonly step: string; readonly argument: string }[];
      readonly presignSteps?: readonly string[];
      readonly triggers: readonly ('manual' | 'schedule')[];
      readonly expiresInDays?: number;
      readonly note?: string;
    },
  ): Promise<Result<StandingView>> {
    return this.call('POST', `/workspaces/${enc(ws)}/standing-approvals`, (b) => parseStanding(b), this.json(body));
  }
  listStandingApprovals(ws: string): Promise<Result<StandingView[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/standing-approvals`, parseStandingList);
  }
  getStandingApproval(ws: string, id: string): Promise<Result<StandingView>> {
    return this.call('GET', `/workspaces/${enc(ws)}/standing-approvals/${enc(id)}`, (b) => parseStanding(b));
  }
  /** A reviewer approves the policy they were shown, named by its digest. */
  approveStandingApproval(ws: string, id: string, policyDigest: string): Promise<Result<StandingView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/standing-approvals/${enc(id)}/approve`,
      (b) => parseStanding(b),
      this.json({ policyDigest }),
    );
  }
  requestStandingChanges(ws: string, id: string, comment: string): Promise<Result<StandingView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/standing-approvals/${enc(id)}/request-changes`,
      (b) => parseStanding(b),
      this.json({ comment }),
    );
  }
  revokeStandingApproval(ws: string, id: string, reason: string): Promise<Result<StandingView>> {
    return this.call('POST', `/workspaces/${enc(ws)}/standing-approvals/${enc(id)}/revoke`, (b) => parseStanding(b), this.json({ reason }));
  }
  /** Starts a run under a standing approval; outside its bounds the platform prepares a batch preview instead (nothing is sent). */
  startUnderStanding(ws: string, id: string, idempotencyKey: string): Promise<Result<StandingStart>> {
    return this.call('POST', `/workspaces/${enc(ws)}/standing-approvals/${enc(id)}/runs`, parseStandingStart, {
      ...this.json({}),
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  // ---- UW-12b (ADR 0052): evidence, outputs, live inbox, delegation, request changes, run learning, workspace knowledge, stops
  runEvidence(ws: string, definitionId: string, runId: string, item?: number) {
    const q = item !== undefined ? `?item=${item}` : '';
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/evidence${q}`,
      parseRunEvidence,
    );
  }
  runOutputs(ws: string, definitionId: string, runId: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/outputs`, parseRunOutputs);
  }
  /** Waits (at most `waitSeconds`) until the inbox differs from `etag`. */
  inboxChanges(ws: string, etag: string | undefined, waitSeconds: number) {
    const q = new URLSearchParams({ wait: String(Math.max(0, Math.min(25, Math.floor(waitSeconds)))) });
    if (etag !== undefined) q.set('etag', etag);
    return this.call('GET', `/workspaces/${enc(ws)}/control/inbox/changes?${q.toString()}`, parseInboxChanges);
  }
  delegateStep(ws: string, definitionId: string, runId: string, approvalId: string, to: string, reason: string) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/approvals/${enc(approvalId)}/delegate`,
      (b) => b,
      this.json({ to, reason }),
    );
  }
  requestBatchChanges(ws: string, definitionId: string, previewId: string, comment: string) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/previews/${enc(previewId)}/request-changes`,
      (b) => b,
      this.json({ comment }),
    );
  }
  runObservations(ws: string, definitionId: string, runId: string) {
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/observations`,
      parseObservations,
    );
  }
  recordRunCorrection(
    ws: string,
    definitionId: string,
    runId: string,
    body: { readonly item?: number; readonly field: string; readonly value: string | number | boolean; readonly reason: string },
  ) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/corrections`,
      (b) => b,
      this.json(body),
    );
  }
  proposeRunLearning(ws: string, definitionId: string, runId: string, observationIds: readonly string[]) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/learning-proposals`,
      (b) => parseChangeSet((b as { changeSet?: unknown }).changeSet),
      this.json({ observationIds }),
    );
  }
  xoKnowledgeState(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/state`, parseKnowledgeHead);
  }
  xoKnowledgeRecords(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/records`, parseKnowledgeRecords);
  }
  xoKnowledgePacks(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/packs`, parseKnowledgePacks);
  }
  xoKnowledgeSearch(ws: string, q: string) {
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/knowledge/search?${new URLSearchParams({ q, limit: '20' }).toString()}`,
      parseKnowledgeHits,
    );
  }
  xoKnowledgeConflicts(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/conflicts`, parseKnowledgeConflicts);
  }
  xoKnowledgeChangeSets(ws: string, status?: string) {
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/knowledge/change-sets${status !== undefined ? `?status=${enc(status)}` : ''}`,
      parseChangeSets,
    );
  }
  xoKnowledgeChangeSetPreview(ws: string, changeSetId: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/change-sets/${enc(changeSetId)}/preview`, parseChangeSetPreview);
  }
  decideKnowledgeChangeSet(ws: string, changeSetId: string, action: 'approve' | 'reject', reason: string) {
    return this.call('POST', `/workspaces/${enc(ws)}/knowledge/change-sets/${enc(changeSetId)}/${action}`, (b) => b, this.json({ reason }));
  }
  xoKnowledgeStates(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/states`, parseKnowledgeStates);
  }
  proposeKnowledgeRollback(ws: string, toStateId: string, reason: string) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/knowledge/rollbacks`,
      (b) => parseChangeSet((b as { changeSet?: unknown }).changeSet),
      this.json({ toStateId, reason }),
    );
  }
  verifyKnowledgeState(ws: string, stateId: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/knowledge/states/${enc(stateId)}/verify`, parseVerify);
  }
  listEmergencyStops(ws: string) {
    return this.call('GET', `/workspaces/${enc(ws)}/emergency-stops`, parseEmergencyStops);
  }
  engageEmergencyStop(ws: string, scope: string, target: string, reason: string) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/emergency-stops`,
      (b) => parseStopList((b as { stops?: unknown }).stops),
      this.json({ scope, target, ...(reason.trim() !== '' ? { reason: reason.trim() } : {}) }),
    );
  }
  releaseEmergencyStop(ws: string, scope: string, target: string) {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/emergency-stops/release`,
      (b) => parseStopList((b as { stops?: unknown }).stops),
      this.json({ scope, target }),
    );
  }
  /** Revokes a batch approval that has not been used. */
  revokeBatchApproval(
    ws: string,
    definitionId: string,
    previewId: string,
    reason: string,
  ): Promise<Result<{ readonly previewId: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/previews/${enc(previewId)}/approval/revoke`,
      (b) => ({ previewId: String((b as { previewId?: unknown }).previewId ?? previewId) }),
      this.json({ reason }),
    );
  }
  /** Starts an approved batch with the approved input. A repeat with the same approval returns the same run. */
  startApprovedBatch(ws: string, definitionId: string, certificateId: string, batchApprovalId: string): Promise<Result<GeneratedRunView>> {
    return this.call('POST', `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs`, (b) => parseGeneratedRun(b), {
      ...this.json({ certificateId, batchApprovalId }),
    });
  }
  /** Cancels a run, a whole batch or one item; the platform records it first and starts no call after it. */
  cancelGeneratedRun(ws: string, definitionId: string, runId: string, reason?: string): Promise<Result<GeneratedRunView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/cancel`,
      (b) => parseGeneratedRun(b),
      this.json(reason !== undefined ? { reason } : {}),
    );
  }
  /** A person records what happened to a call whose outcome is unknown. Nothing is sent again. */
  reconcileGeneratedEffect(
    ws: string,
    definitionId: string,
    runId: string,
    step: string,
    input: {
      readonly decision: 'confirmed_success' | 'confirmed_failure_no_effect' | 'unresolved';
      readonly reason: string;
      readonly evidenceExamined?: string;
    },
  ): Promise<Result<{ readonly runId: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/generated-workflows/${enc(definitionId)}/runs/${enc(runId)}/effects/${enc(step)}/reconciliation`,
      (b) => ({ runId: String((b as { runId?: unknown }).runId ?? runId) }),
      this.json(input),
    );
  }
  /** S1-0: every run in the workspace, across workflows, newest first (Activity, and a workflow's latest run). */
  listWorkspaceRuns(ws: string, q: { readonly cursor?: string; readonly limit?: number } = {}): Promise<Result<WorkspaceRunPage>> {
    const params = new URLSearchParams();
    if (q.cursor !== undefined) params.set('cursor', q.cursor);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return this.call('GET', `/workspaces/${enc(ws)}/runs${qs.length > 0 ? `?${qs}` : ''}`, parseWorkspaceRunPage);
  }
  // ---- UW-2: Workflow entities (durable work items, linked to the conversation they were asked in) ----
  listWorkflowEntities(
    ws: string,
    q: { readonly cursor?: string; readonly limit?: number; readonly lifecycle?: WorkflowLifecycle; readonly archived?: boolean } = {},
  ): Promise<Result<WorkflowPage>> {
    const params = new URLSearchParams();
    if (q.cursor !== undefined) params.set('cursor', q.cursor);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.lifecycle !== undefined) params.set('lifecycle', q.lifecycle);
    if (q.archived === true) params.set('archived', 'true');
    const qs = params.toString();
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-entities${qs.length > 0 ? `?${qs}` : ''}`, parseWorkflowPage);
  }
  /** UW-12a: start a conversation with what XO found in the workspace's connected folders (the conversation is the caller's). */
  startDiscoveryConversation(ws: string): Promise<Result<ChatThreadFull>> {
    return this.call('POST', `/workspaces/${enc(ws)}/discovery/conversation`, parseChatThread, {
      body: JSON.stringify({}),
      contentType: 'application/json',
    });
  }
  /** UW-12a: confirm or reject what XO thinks a file or folder is. Goes through the source-connection API, never the conversation. */
  decideSourceRole(ws: string, connectionId: string, proposalId: string, decision: 'confirmed' | 'rejected'): Promise<Result<true>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/source-connections/${enc(connectionId)}/proposals/${enc(proposalId)}/decision`,
      () => true as const,
      { body: JSON.stringify({ decision }), contentType: 'application/json' },
    );
  }
  // ---- UW-12a: the workspace's source connections (docs/SOURCE_CONNECTIONS.md). The server decides every action again.
  sourceConnectionOptions(ws: string): Promise<Result<SourceConnectionOptions>> {
    return this.call('GET', `/workspaces/${enc(ws)}/source-connections/options`, parseConnectionOptions);
  }
  listSourceConnections(ws: string): Promise<Result<SourceConnectionSummary[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/source-connections`, parseConnectionList);
  }
  getSourceConnection(ws: string, id: string): Promise<Result<SourceConnectionDetail>> {
    return this.call('GET', `/workspaces/${enc(ws)}/source-connections/${enc(id)}`, (b) => parseConnectionAnswer(b).connection);
  }
  /** Connects a folder, a drive folder, or (agent_folder) a folder on another computer, which answers a one-time pairing code. */
  createSourceConnection(
    ws: string,
    body:
      | { readonly kind: 'local_folder'; readonly root: string }
      | { readonly kind: 'microsoft_drive' | 'google_drive'; readonly credentialId: string; readonly folder: string }
      | { readonly kind: 'agent_folder' },
  ): Promise<Result<{ readonly connection: SourceConnectionDetail; readonly pairing?: Pairing }>> {
    return this.call('POST', `/workspaces/${enc(ws)}/source-connections`, parseConnectionAnswer, this.json(body));
  }
  /** Sync now. For a folder on another computer this asks its agent, which syncs within about a minute. */
  syncSourceConnection(ws: string, id: string): Promise<Result<SourceConnectionDetail>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/source-connections/${enc(id)}/sync`,
      (b) => parseConnectionAnswer(b).connection,
      this.json({}),
    );
  }
  changeSourceConnection(ws: string, id: string, action: 'pause' | 'resume' | 'retire'): Promise<Result<SourceConnectionDetail>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/source-connections/${enc(id)}/${action}`,
      (b) => parseConnectionAnswer(b).connection,
      this.json({}),
    );
  }
  scheduleSourceConnection(
    ws: string,
    id: string,
    sync: { readonly mode: 'manual' } | { readonly mode: 'interval'; readonly everyMinutes: number },
  ): Promise<Result<SourceConnectionDetail>> {
    return this.call(
      'PUT',
      `/workspaces/${enc(ws)}/source-connections/${enc(id)}/schedule`,
      (b) => parseConnectionAnswer(b).connection,
      this.json({ sync }),
    );
  }
  /** A new pairing code for a folder on another computer; the agent paired before stops working at once. */
  pairSourceAgent(ws: string, id: string): Promise<Result<{ readonly connection: SourceConnectionDetail; readonly pairing?: Pairing }>> {
    return this.call('POST', `/workspaces/${enc(ws)}/source-connections/${enc(id)}/agent/pair`, parseConnectionAnswer, this.json({}));
  }
  driveFolders(ws: string, provider: DriveProvider, credentialId: string, parent?: string): Promise<Result<DriveFolder[]>> {
    const q = new URLSearchParams({ provider, credentialId, ...(parent !== undefined ? { parent } : {}) });
    return this.call('GET', `/workspaces/${enc(ws)}/source-connections/drive-folders?${q.toString()}`, parseDriveFolders);
  }
  /** The workspace's accounts that can read files. */
  driveAccounts(ws: string): Promise<Result<DriveAccount[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/credentials`, parseDriveAccounts);
  }
  /** Starts consent for read-only file access; the person finishes it at the provider, in their browser. */
  startDriveConsent(
    ws: string,
    provider: DriveProvider,
  ): Promise<Result<{ readonly authorizationUrl: string; readonly expiresAt: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/credentials/oauth`,
      parseConsent,
      this.json({ provider, capabilities: ['files.read'] }),
    );
  }
  /** The workflows created from one of the caller's own conversations. */
  listConversationWorkflows(ws: string, conversationId: string): Promise<Result<WorkflowPage>> {
    return this.call('GET', `/workspaces/${enc(ws)}/intelligence/conversations/${enc(conversationId)}/workflows`, parseWorkflowPage);
  }
  getWorkflowEntity(ws: string, workflowId: string): Promise<Result<WorkflowDetailView>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}`, (b) => parseWorkflowDetail(b));
  }
  /** S1-3b: creates a workflow from a goal and a source XO has read (a proposal from the Ask box). Creating is not starting; `null` when the platform asks a question instead. */
  createWorkflowFromGoal(
    ws: string,
    input: { readonly compilationId: string; readonly goal: string },
  ): Promise<Result<WorkflowDetailView | null>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-entities`,
      parseWorkflowReply,
      this.json({ compilationId: input.compilationId, goal: { text: input.goal } }),
    );
  }
  /** Creates a workflow from a message the person wrote in a conversation; `null` when the platform asks a question instead. */
  createWorkflowFromConversation(
    ws: string,
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly compilationId: string;
      readonly goal?: { readonly text: string; readonly needs?: readonly string[] };
      readonly name?: string;
    },
  ): Promise<Result<WorkflowDetailView | null>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-entities`, parseWorkflowReply, this.json(input));
  }
  certifyWorkflowEntity(ws: string, workflowId: string): Promise<Result<ReadinessCertificateView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/readiness`,
      (b) => parseReadinessCertificate((b as { certificate?: unknown }).certificate),
      this.json({}),
    );
  }
  /** Starts the current version; the platform presents the latest certificate for it and verifies it from scratch. */
  startWorkflowEntityRun(
    ws: string,
    workflowId: string,
    input: Readonly<Record<string, unknown>> = {},
    idempotencyKey?: string,
  ): Promise<Result<GeneratedRunView>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/runs`, (b) => parseGeneratedRun(b), {
      ...this.json({ input }),
      ...(idempotencyKey !== undefined ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  decideWorkflowEntityApproval(
    ws: string,
    workflowId: string,
    runId: string,
    approvalId: string,
    action: 'approve' | 'reject',
    comment?: string,
  ): Promise<Result<GeneratedRunView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/runs/${enc(runId)}/approvals/${enc(approvalId)}`,
      (b) => parseGeneratedRun(b),
      this.json({ action, ...(comment !== undefined ? { comment } : {}) }),
    );
  }
  /** UW-7: cancels a run (or a whole batch); the platform records it first and stops every later call. */
  cancelWorkflowEntityRun(ws: string, workflowId: string, runId: string, reason?: string): Promise<Result<GeneratedRunView>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/runs/${enc(runId)}/cancel`,
      (b) => parseGeneratedRun(b),
      this.json(reason !== undefined ? { reason } : {}),
    );
  }
  /** UW-7: a reviewer records what happened to a call whose outcome is unknown. Nothing is sent again. */
  reconcileWorkflowEntityEffect(
    ws: string,
    workflowId: string,
    runId: string,
    step: string,
    input: {
      readonly decision: 'confirmed_success' | 'confirmed_failure_no_effect' | 'unresolved';
      readonly reason: string;
      readonly evidenceExamined?: string;
    },
  ): Promise<Result<{ readonly runId: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/runs/${enc(runId)}/effects/${enc(step)}/reconciliation`,
      (b) => ({ runId: String((b as { runId?: unknown }).runId ?? runId) }),
      this.json(input),
    );
  }
  /** S1-5: rename a workflow. `expectedRevision` makes a change made elsewhere in the meantime a refusal, not an overwrite. */
  renameWorkflowEntity(ws: string, workflowId: string, name: string, expectedRevision: number): Promise<Result<WorkflowDetailView | null>> {
    return this.call(
      'PATCH',
      `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}`,
      parseWorkflowReply,
      this.json({ name, expectedRevision }),
    );
  }
  setWorkflowEntityFlag(
    ws: string,
    workflowId: string,
    action: 'pause' | 'resume' | 'archive' | 'restore',
  ): Promise<Result<WorkflowDetailView | null>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-entities/${enc(workflowId)}/${action}`, parseWorkflowReply, this.json({}));
  }
  /** Changes after `cursor`; with `waitSeconds` the platform holds the call until something changes (at most 25 s). */
  workflowChanges(
    ws: string,
    cursor: string,
    waitSeconds = 0,
  ): Promise<Result<{ readonly changes: readonly WorkflowChangeView[]; readonly cursor: string }>> {
    return this.call(
      'GET',
      `/workspaces/${enc(ws)}/workflow-entities/changes?cursor=${enc(cursor)}&wait=${Math.max(0, Math.min(25, Math.floor(waitSeconds)))}`,
      parseWorkflowChanges,
    );
  }
  /** Whether a certificate still allows a start: the same check the start gate makes. */
  /** UW-10: how each email binding of the workspace sends (tier, lookup, plain words). */
  emailTiers(ws: string): Promise<Result<EmailTierLine[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/connector-bindings`, parseEmailTiers);
  }
  checkReadinessCertificate(ws: string, certificateId: string): Promise<Result<CertificateCheck>> {
    return this.call('GET', `/workspaces/${enc(ws)}/readiness-certificates/${enc(certificateId)}/verify`, parseCertificateCheck);
  }
  setWorkflowMode(ws: string, workflowId: string, compilationId: string, mode: WorkflowMode): Promise<Result<WorkflowControl>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-controls/workflows/${enc(workflowId)}/mode`,
      (b) => parseWorkflowControl(b),
      this.json({ compilationId, mode }),
    );
  }
  /** `null` removes the limit. */
  setWorkflowLimit(ws: string, workflowId: string, compilationId: string, dailyRunCap: number | null): Promise<Result<WorkflowControl>> {
    return this.call(
      'PUT',
      `/workspaces/${enc(ws)}/workflow-controls/workflows/${enc(workflowId)}/limits`,
      (b) => parseWorkflowControl(b),
      this.json({ compilationId, dailyRunCap }),
    );
  }
  setWorkflowTriggers(
    ws: string,
    workflowId: string,
    compilationId: string,
    change: {
      webhook?: boolean;
      schedule?: {
        everyMinutes: number;
        input?: Record<string, unknown>;
        certificateId?: string;
        items?: { connectionId: string; proposalId: string };
        standingApprovalId?: string;
      } | null;
    },
  ): Promise<Result<WorkflowControl>> {
    return this.call(
      'PUT',
      `/workspaces/${enc(ws)}/workflow-controls/workflows/${enc(workflowId)}/triggers`,
      (b) => parseWorkflowControl(b),
      this.json({ compilationId, ...change }),
    );
  }
  signOffWorkflow(ws: string, workflowId: string, compilationId: string): Promise<Result<WorkflowControl>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-controls/workflows/${enc(workflowId)}/sign-off`,
      (b) => parseWorkflowControl(b),
      this.json({ compilationId }),
    );
  }
  pauseEverything(ws: string, reason?: string): Promise<Result<{ paused: boolean; reason?: string }>> {
    return this.call(
      'POST',
      `/workspaces/${enc(ws)}/workflow-controls/pause`,
      parsePauseState,
      this.json(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
    );
  }
  resumeEverything(ws: string): Promise<Result<{ paused: boolean; reason?: string }>> {
    return this.call('POST', `/workspaces/${enc(ws)}/workflow-controls/resume`, parsePauseState, this.json({}));
  }
  listWorkflowRuns(ws: string): Promise<Result<WorkflowRun[]>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-executions`, parseWorkflowRunList);
  }
  getWorkflowRun(ws: string, workflowExecutionId: string): Promise<Result<WorkflowRun>> {
    return this.call('GET', `/workspaces/${enc(ws)}/workflow-executions/${enc(workflowExecutionId)}`, (b) => parseWorkflowRun(b));
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

interface UploadSessionWire {
  readonly uploadId: string;
  readonly offset: number;
  readonly size: number;
  readonly maxChunkBytes: number;
}

function parseUploadSession(v: unknown): UploadSessionWire {
  const o = obj(v, 'body');
  return {
    uploadId: str(o['uploadId'], 'uploadId'),
    offset: num(o['offset'], 'offset'),
    size: num(o['size'], 'size'),
    maxChunkBytes: num(o['maxChunkBytes'], 'maxChunkBytes'),
  };
}

/** S1-3: what `GET /version` reports. */
export interface PlatformVersion {
  readonly version: string;
  readonly features: {
    readonly connect: boolean;
    readonly googleSignIn: boolean;
    readonly oidc: boolean;
    readonly passwordSignIn: boolean;
  };
}
export function parsePlatformVersion(v: unknown): PlatformVersion {
  if (typeof v !== 'object' || v === null) throw new WireParseError('body', 'an object');
  const o = v as Record<string, unknown>;
  const f = o['features'];
  if (typeof o['version'] !== 'string' || !/^\d+\.\d+\.\d+/.test(o['version'])) throw new WireParseError('version', 'a version string');
  if (typeof f !== 'object' || f === null) throw new WireParseError('features', 'an object');
  const b = (k: string) => (f as Record<string, unknown>)[k] === true;
  return {
    version: o['version'],
    features: { connect: b('connect'), googleSignIn: b('googleSignIn'), oidc: b('oidc'), passwordSignIn: b('passwordSignIn') },
  };
}
export interface ClientErrorReport {
  readonly kind: 'uncaught' | 'render' | 'unhandled-rejection';
  readonly message: string;
  readonly component?: string;
  readonly route?: string;
  readonly build?: string;
  readonly count: number;
}
