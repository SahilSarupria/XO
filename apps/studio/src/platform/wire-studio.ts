/**
 * Wire types and parsers for the Studio backend routes added alongside members/roles, audit, settings, inbox, library,
 * chat, workflow drafts and capability preview (apps/api/src/openapi-studio.ts is the contract).
 *
 * Same rule as `wire.ts`: nothing the network returns is trusted until it parses. A field Studio relies on that is
 * missing or the wrong type is a `malformed` problem, not a blank cell. Trust metadata is parsed LITERALLY: a literal
 * `false` for `signaturesVerified` / `independentlyVerified` is part of the type, so the UI cannot render a
 * "verified" state from data that says otherwise.
 */
import { arr, bool, num, obj, optStr, str, strArr, WORKSPACE_ROLES, WireParseError, type WorkspaceRole } from './wire';

type Json = Record<string, unknown>;
const role = (v: unknown, path: string): WorkspaceRole => {
  const r = str(v, path);
  if (!(WORKSPACE_ROLES as readonly string[]).includes(r)) throw new WireParseError(path, 'a workspace role');
  return r as WorkspaceRole;
};
const optNum = (v: unknown, path: string): number | undefined => (v === undefined ? undefined : num(v, path));
const literalFalse = (v: unknown, path: string): false => {
  if (v !== false) throw new WireParseError(path, 'false (this server never verifies this)');
  return false;
};
const list = <T>(v: unknown, path: string, one: (x: unknown, p: string) => T): T[] => arr(v, path).map((x, i) => one(x, `${path}[${i}]`));

// ------------------------------------------------------------------ members and roles
export type WorkspacePermission = 'read' | 'author' | 'publish' | 'review' | 'audit' | 'manage';
export interface Member {
  readonly identityId: string;
  readonly role: WorkspaceRole;
  readonly isOwner: boolean;
  readonly displayName?: string;
  readonly email?: string;
  readonly addedAt?: string;
}
export interface MemberList {
  readonly members: readonly Member[];
  readonly total: number;
  readonly roleCounts: Readonly<Record<WorkspaceRole, number>>;
  readonly callerRole: WorkspaceRole;
  readonly callerPermissions: readonly WorkspacePermission[];
}
export function parseMember(v: unknown, path = 'member'): Member {
  const o = obj(v, path);
  const displayName = optStr(o['displayName'], `${path}.displayName`);
  const email = optStr(o['email'], `${path}.email`);
  const addedAt = optStr(o['addedAt'], `${path}.addedAt`);
  return {
    identityId: str(o['identityId'], `${path}.identityId`),
    role: role(o['role'], `${path}.role`),
    isOwner: bool(o['isOwner'], `${path}.isOwner`),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(addedAt !== undefined ? { addedAt } : {}),
  };
}
export function parseMemberList(v: unknown): MemberList {
  const o = obj(v, 'body');
  const counts = obj(o['roleCounts'], 'roleCounts');
  return {
    members: list(o['members'], 'members', parseMember),
    total: num(o['total'], 'total'),
    roleCounts: Object.fromEntries(WORKSPACE_ROLES.map((r) => [r, num(counts[r], `roleCounts.${r}`)])) as Record<WorkspaceRole, number>,
    callerRole: role(o['callerRole'], 'callerRole'),
    callerPermissions: strArr(o['callerPermissions'], 'callerPermissions') as WorkspacePermission[],
  };
}
export function parseMemberEnvelope(v: unknown): Member {
  return parseMember(obj(v, 'body')['member'], 'member');
}

// ------------------------------------------------------------------ audit
export type AuditResult = 'succeeded' | 'failed' | 'denied' | 'escalated' | 'approved' | 'rejected';
export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly event: string;
  readonly result: AuditResult;
  readonly actor: { readonly identityId: string; readonly kind: string; readonly role?: string; readonly displayName?: string };
  readonly target?: { readonly kind: string; readonly id: string; readonly label?: string };
}
const RESULTS: readonly string[] = ['succeeded', 'failed', 'denied', 'escalated', 'approved', 'rejected'];
export function parseAuditEntry(v: unknown, path = 'event'): AuditEntry {
  const o = obj(v, path);
  const a = obj(o['actor'], `${path}.actor`);
  const result = str(o['result'], `${path}.result`);
  if (!RESULTS.includes(result)) throw new WireParseError(`${path}.result`, 'a known audit result');
  const t = o['target'] === undefined ? undefined : obj(o['target'], `${path}.target`);
  const aRole = optStr(a['role'], `${path}.actor.role`);
  const aName = optStr(a['displayName'], `${path}.actor.displayName`);
  const tLabel = t !== undefined ? optStr(t['label'], `${path}.target.label`) : undefined;
  return {
    seq: num(o['seq'], `${path}.seq`),
    at: str(o['at'], `${path}.at`),
    event: str(o['event'], `${path}.event`),
    result: result as AuditResult,
    actor: {
      identityId: str(a['identityId'], `${path}.actor.identityId`),
      kind: str(a['kind'], `${path}.actor.kind`),
      ...(aRole !== undefined ? { role: aRole } : {}),
      ...(aName !== undefined ? { displayName: aName } : {}),
    },
    ...(t !== undefined
      ? {
          target: {
            kind: str(t['kind'], `${path}.target.kind`),
            id: str(t['id'], `${path}.target.id`),
            ...(tLabel !== undefined ? { label: tLabel } : {}),
          },
        }
      : {}),
  };
}
export interface AuditPage {
  readonly events: readonly AuditEntry[];
  readonly nextBefore?: number;
}
export function parseAuditPage(v: unknown): AuditPage {
  const o = obj(v, 'body');
  const next = optNum(o['nextBefore'], 'nextBefore');
  return { events: list(o['events'], 'events', parseAuditEntry), ...(next !== undefined ? { nextBefore: next } : {}) };
}
export interface AuditVerification {
  readonly ok: boolean;
  readonly entries: number;
  readonly headHash: string;
  readonly brokenAt?: { readonly seq: number; readonly reason: string };
  /** `null` = the operator declared no retention policy. The server never invents one. */
  readonly retentionMinimumDays: number | null;
  readonly deletionSupported: boolean;
}
export function parseAuditVerification(v: unknown): AuditVerification {
  const o = obj(v, 'body');
  const b = o['brokenAt'] === undefined ? undefined : obj(o['brokenAt'], 'brokenAt');
  const r = obj(o['retention'], 'retention');
  return {
    ok: bool(o['ok'], 'ok'),
    entries: num(o['entries'], 'entries'),
    headHash: str(o['headHash'], 'headHash'),
    ...(b !== undefined ? { brokenAt: { seq: num(b['seq'], 'brokenAt.seq'), reason: str(b['reason'], 'brokenAt.reason') } } : {}),
    retentionMinimumDays: r['minimumDays'] === null ? null : num(r['minimumDays'], 'retention.minimumDays'),
    deletionSupported: bool(r['deletionSupported'], 'retention.deletionSupported'),
  };
}

// ------------------------------------------------------------------ settings and runtime status
export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}
export interface ProviderInfo {
  readonly id: string;
  readonly configured: boolean;
  readonly local: boolean;
}
export interface WorkspaceSettings {
  readonly revision: number;
  readonly runtimeLocation: string;
  readonly primary: ModelChoice | null;
  readonly fallback: ModelChoice | null;
  readonly airGapped: boolean;
  readonly region: string | null;
  readonly requireSignedPackages: boolean;
  readonly notifications: { readonly onEscalation: boolean; readonly onRunFailure: boolean; readonly onWorkflowComplete: boolean };
}
export interface SettingsEffect {
  readonly availableLocations: readonly string[];
  readonly providers: readonly ProviderInfo[];
  /** The server's own statement of what `requireSignedPackages` does. Shown verbatim next to the toggle. */
  readonly signedPackagesNote: string;
  readonly residencyNote: string;
  readonly residencyEnforced: boolean;
}
export interface SettingsView {
  readonly settings: WorkspaceSettings;
  readonly effect: SettingsEffect;
}
function parseChoice(v: unknown, path: string): ModelChoice | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  return { provider: str(o['provider'], `${path}.provider`), model: str(o['model'], `${path}.model`) };
}
export function parseSettingsView(v: unknown): SettingsView {
  const o = obj(v, 'body');
  const s = obj(o['settings'], 'settings');
  const e = obj(o['effect'], 'effect');
  const n = obj(s['notifications'], 'settings.notifications');
  const model = obj(s['model'], 'settings.model');
  const trust = obj(s['trust'], 'settings.trust');
  const residency = obj(s['residency'], 'settings.residency');
  const eRuntime = obj(e['runtime'], 'effect.runtime');
  const eModel = obj(e['model'], 'effect.model');
  const eTrust = obj(e['trust'], 'effect.trust');
  const eRes = obj(e['residency'], 'effect.residency');
  const sign = obj(eTrust['requireSignedPackages'], 'effect.trust.requireSignedPackages');
  return {
    settings: {
      revision: num(s['revision'], 'settings.revision'),
      runtimeLocation: str(obj(s['runtime'], 'settings.runtime')['location'], 'settings.runtime.location'),
      primary: parseChoice(model['primary'], 'settings.model.primary'),
      fallback: parseChoice(model['fallback'], 'settings.model.fallback'),
      airGapped: bool(s['airGapped'], 'settings.airGapped'),
      region: residency['region'] === null ? null : str(residency['region'], 'settings.residency.region'),
      requireSignedPackages: bool(trust['requireSignedPackages'], 'settings.trust.requireSignedPackages'),
      notifications: {
        onEscalation: bool(n['onEscalation'], 'notifications.onEscalation'),
        onRunFailure: bool(n['onRunFailure'], 'notifications.onRunFailure'),
        onWorkflowComplete: bool(n['onWorkflowComplete'], 'notifications.onWorkflowComplete'),
      },
    },
    effect: {
      availableLocations: strArr(eRuntime['availableLocations'], 'effect.runtime.availableLocations'),
      providers: list(eModel['providers'], 'effect.model.providers', (p, path) => {
        const po = obj(p, path);
        return {
          id: str(po['id'], `${path}.id`),
          configured: bool(po['configured'], `${path}.configured`),
          local: bool(po['local'], `${path}.local`),
        };
      }),
      signedPackagesNote: str(sign['note'], 'effect.trust.requireSignedPackages.note'),
      residencyNote: str(eRes['note'], 'effect.residency.note'),
      residencyEnforced: bool(eRes['enforced'], 'effect.residency.enforced'),
    },
  };
}
export interface Region {
  readonly id: string;
  readonly label: string;
}
export function parseRegions(v: unknown): Region[] {
  return list(obj(v, 'body')['regions'], 'regions', (r, path) => {
    const o = obj(r, path);
    return { id: str(o['id'], `${path}.id`), label: str(o['label'], `${path}.label`) };
  });
}
export type RuntimeState = 'online' | 'degraded' | 'offline';
export interface RuntimeStatus {
  readonly status: RuntimeState;
  readonly location: string;
  readonly checkedAt: string;
  readonly mountedPackages: number;
  readonly capabilityCount: number;
  readonly warnings: readonly string[];
  readonly modelUsable: boolean;
  readonly airGapped: boolean;
}
export function parseRuntimeStatus(v: unknown): RuntimeStatus {
  const o = obj(v, 'body');
  const status = str(o['status'], 'status');
  if (status !== 'online' && status !== 'degraded' && status !== 'offline')
    throw new WireParseError('status', 'online | degraded | offline');
  const rt = obj(o['runtime'], 'runtime');
  return {
    status,
    location: str(o['location'], 'location'),
    checkedAt: str(o['checkedAt'], 'checkedAt'),
    mountedPackages: num(rt['mountedPackages'], 'runtime.mountedPackages'),
    capabilityCount: num(rt['capabilityCount'], 'runtime.capabilityCount'),
    warnings: strArr(rt['warnings'], 'runtime.warnings'),
    modelUsable: bool(obj(o['model'], 'model')['usable'], 'model.usable'),
    airGapped: bool(o['airGapped'], 'airGapped'),
  };
}

// ------------------------------------------------------------------ notifications
export type NotificationKind = 'escalation' | 'run_failure' | 'workflow_complete';
export interface Notification {
  readonly seq: number;
  readonly at: string;
  readonly kind: NotificationKind;
  readonly event: string;
  readonly targetLabel?: string;
  readonly read: boolean;
}
export interface NotificationFeed {
  readonly notifications: readonly Notification[];
  readonly unread: number;
}
export function parseNotificationFeed(v: unknown): NotificationFeed {
  const o = obj(v, 'body');
  return {
    notifications: list(o['notifications'], 'notifications', (n, path) => {
      const x = obj(n, path);
      const kind = str(x['kind'], `${path}.kind`);
      if (kind !== 'escalation' && kind !== 'run_failure' && kind !== 'workflow_complete')
        throw new WireParseError(`${path}.kind`, 'a notification kind');
      const target = x['target'] === undefined ? undefined : obj(x['target'], `${path}.target`);
      const label = target !== undefined ? optStr(target['label'], `${path}.target.label`) : undefined;
      return {
        seq: num(x['seq'], `${path}.seq`),
        at: str(x['at'], `${path}.at`),
        kind,
        event: str(x['event'], `${path}.event`),
        ...(label !== undefined ? { targetLabel: label } : {}),
        read: bool(x['read'], `${path}.read`),
      };
    }),
    unread: num(o['unread'], 'unread'),
  };
}

// ------------------------------------------------------------------ inbox
export interface InfoRequest {
  readonly requestId: string;
  readonly question: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly answer?: string;
  readonly answeredBy?: string;
  readonly answeredAt?: string;
}
export function parseInfoRequest(v: unknown, path = 'infoRequest'): InfoRequest {
  const o = obj(v, path);
  const answer = optStr(o['answer'], `${path}.answer`);
  const answeredBy = optStr(o['answeredBy'], `${path}.answeredBy`);
  const answeredAt = optStr(o['answeredAt'], `${path}.answeredAt`);
  return {
    requestId: str(o['requestId'], `${path}.requestId`),
    question: str(o['question'], `${path}.question`),
    requestedBy: str(o['requestedBy'], `${path}.requestedBy`),
    requestedAt: str(o['requestedAt'], `${path}.requestedAt`),
    ...(answer !== undefined ? { answer } : {}),
    ...(answeredBy !== undefined ? { answeredBy } : {}),
    ...(answeredAt !== undefined ? { answeredAt } : {}),
  };
}
export interface InboxItem {
  readonly executionId: string;
  readonly state: 'needs_review' | 'done';
  readonly title: string;
  readonly capabilityId: string;
  readonly compilationId: string;
  readonly sourceFilename?: string;
  readonly confidence?: number;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly decision?: string;
  readonly resolverIdentityId?: string;
  readonly openInfoRequests: number;
  readonly workflowName?: string;
}
export function parseInboxItem(v: unknown, path = 'item'): InboxItem {
  const o = obj(v, path);
  const state = str(o['state'], `${path}.state`);
  if (state !== 'needs_review' && state !== 'done') throw new WireParseError(`${path}.state`, 'needs_review | done');
  const sourceFilename = optStr(o['sourceFilename'], `${path}.sourceFilename`);
  const resolvedAt = optStr(o['resolvedAt'], `${path}.resolvedAt`);
  const decision = optStr(o['decision'], `${path}.decision`);
  const resolver = optStr(o['resolverIdentityId'], `${path}.resolverIdentityId`);
  const wf = o['workflow'] === undefined ? undefined : obj(o['workflow'], `${path}.workflow`);
  return {
    executionId: str(o['executionId'], `${path}.executionId`),
    state,
    title: str(o['title'], `${path}.title`),
    capabilityId: str(o['capabilityId'], `${path}.capabilityId`),
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    ...(sourceFilename !== undefined ? { sourceFilename } : {}),
    ...(o['confidence'] !== undefined ? { confidence: num(o['confidence'], `${path}.confidence`) } : {}),
    requestedAt: str(o['requestedAt'], `${path}.requestedAt`),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(resolver !== undefined ? { resolverIdentityId: resolver } : {}),
    openInfoRequests: num(o['openInfoRequests'], `${path}.openInfoRequests`),
    ...(wf !== undefined ? { workflowName: str(wf['workflowName'], `${path}.workflow.workflowName`) } : {}),
  };
}
export interface InboxList {
  readonly items: readonly InboxItem[];
  readonly counts: { readonly needsReview: number; readonly done: number };
}
export function parseInboxList(v: unknown): InboxList {
  const o = obj(v, 'body');
  const c = obj(o['counts'], 'counts');
  return {
    items: list(o['items'], 'items', parseInboxItem),
    counts: { needsReview: num(c['needsReview'], 'counts.needsReview'), done: num(c['done'], 'counts.done') },
  };
}
export interface InboxDetail extends InboxItem {
  readonly capabilityDescription?: string;
  readonly escalation: unknown;
  readonly input: unknown;
  readonly infoRequests: readonly InfoRequest[];
}
export function parseInboxDetail(v: unknown): InboxDetail {
  const o = obj(v, 'body');
  const cap = o['capability'] === undefined ? undefined : obj(o['capability'], 'capability');
  const desc = cap !== undefined ? optStr(cap['description'], 'capability.description') : undefined;
  return {
    ...parseInboxItem(o, 'detail'),
    ...(desc !== undefined ? { capabilityDescription: desc } : {}),
    escalation: o['escalation'],
    input: o['input'],
    infoRequests: list(o['infoRequests'], 'infoRequests', parseInfoRequest),
  };
}

// ------------------------------------------------------------------ library
export interface LibraryTrust {
  /** Signature ENTRIES are present in the manifest. This is not verification. */
  readonly signed: boolean;
  readonly signerCount: number;
  readonly signaturesVerified: false;
  readonly benchmarked: boolean;
  readonly overallScore: number | null;
  readonly independentlyVerified: false;
}
export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly publishedAt: string;
  readonly summary: string | null;
  readonly capabilities: readonly { readonly id: string; readonly name: string }[];
  readonly installed: boolean;
  readonly madeByMe: boolean;
  readonly trust: LibraryTrust;
}
export function parseLibraryItem(v: unknown, path = 'item'): LibraryItem {
  const o = obj(v, path);
  const t = obj(o['trust'], `${path}.trust`);
  return {
    id: str(o['id'], `${path}.id`),
    name: str(o['name'], `${path}.name`),
    version: str(o['version'], `${path}.version`),
    creatorDid: str(o['creatorDid'], `${path}.creatorDid`),
    publishedAt: str(o['publishedAt'], `${path}.publishedAt`),
    summary: o['summary'] === null ? null : str(o['summary'], `${path}.summary`),
    capabilities: list(o['capabilities'], `${path}.capabilities`, (c, p) => {
      const co = obj(c, p);
      return { id: str(co['id'], `${p}.id`), name: str(co['name'], `${p}.name`) };
    }),
    installed: bool(o['installed'], `${path}.installed`),
    madeByMe: bool(o['madeByMe'], `${path}.madeByMe`),
    trust: {
      signed: bool(t['signed'], `${path}.trust.signed`),
      signerCount: num(t['signerCount'], `${path}.trust.signerCount`),
      signaturesVerified: literalFalse(t['signaturesVerified'], `${path}.trust.signaturesVerified`),
      benchmarked: bool(t['benchmarked'], `${path}.trust.benchmarked`),
      overallScore: t['overallScore'] === null ? null : num(t['overallScore'], `${path}.trust.overallScore`),
      independentlyVerified: literalFalse(t['independentlyVerified'], `${path}.trust.independentlyVerified`),
    },
  };
}
export interface LibraryList {
  readonly items: readonly LibraryItem[];
  readonly counts: { readonly all: number; readonly installed: number; readonly mine: number };
}
export function parseLibraryList(v: unknown): LibraryList {
  const o = obj(v, 'body');
  const c = obj(o['counts'], 'counts');
  return {
    items: list(o['items'], 'items', parseLibraryItem),
    counts: { all: num(c['all'], 'counts.all'), installed: num(c['installed'], 'counts.installed'), mine: num(c['mine'], 'counts.mine') },
  };
}
export interface LibraryDetail extends LibraryItem {
  readonly byCategory: Readonly<Record<string, number>>;
  readonly runs: number;
  readonly signers: readonly string[];
  readonly installable: boolean;
}
export function parseLibraryDetail(v: unknown): LibraryDetail {
  const o = obj(v, 'body');
  const b = obj(o['benchmarks'], 'benchmarks');
  const cats = obj(b['byCategory'], 'benchmarks.byCategory');
  return {
    ...parseLibraryItem(o, 'package'),
    byCategory: Object.fromEntries(Object.entries(cats).map(([k, x]) => [k, num(x, `benchmarks.byCategory.${k}`)])),
    runs: num(b['runs'], 'benchmarks.runs'),
    signers: list(o['signatures'], 'signatures', (s, p) => str(obj(s, p)['signerDid'], `${p}.signerDid`)),
    installable: bool(o['installable'], 'installable'),
  };
}
export interface Install {
  readonly name: string;
  readonly version: string;
}
export function parseInstalls(v: unknown): Install[] {
  return list(obj(v, 'body')['installs'], 'installs', (i, p) => {
    const o = obj(i, p);
    return { name: str(o['name'], `${p}.name`), version: str(o['version'], `${p}.version`) };
  });
}
export function parseInstalled(v: unknown): Install {
  const o = obj(v, 'body');
  return { name: str(o['name'], 'name'), version: str(o['version'], 'version') };
}

// ------------------------------------------------------------------ chat
export interface ChatSummary {
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}
export interface ChatMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly attachedXos?: readonly string[];
}
export interface ChatThreadFull extends ChatSummary {
  readonly messages: readonly ChatMessage[];
}
function parseChatSummary(v: unknown, path: string): ChatSummary {
  const o = obj(v, path);
  return {
    threadId: str(o['threadId'], `${path}.threadId`),
    title: str(o['title'], `${path}.title`),
    updatedAt: str(o['updatedAt'], `${path}.updatedAt`),
    messageCount: num(o['messageCount'], `${path}.messageCount`),
  };
}
export function parseChatMessage(v: unknown, path = 'message'): ChatMessage {
  const o = obj(v, path);
  const r = str(o['role'], `${path}.role`);
  if (r !== 'user' && r !== 'assistant') throw new WireParseError(`${path}.role`, 'user | assistant');
  const m = o['model'] === undefined ? undefined : obj(o['model'], `${path}.model`);
  return {
    messageId: str(o['messageId'], `${path}.messageId`),
    role: r,
    content: str(o['content'], `${path}.content`),
    at: str(o['at'], `${path}.at`),
    ...(m !== undefined
      ? { model: { provider: str(m['provider'], `${path}.model.provider`), model: str(m['model'], `${path}.model.model`) } }
      : {}),
    ...(o['attachedXos'] !== undefined ? { attachedXos: strArr(o['attachedXos'], `${path}.attachedXos`) } : {}),
  };
}
export const parseChatList = (v: unknown): ChatSummary[] => list(obj(v, 'body')['threads'], 'threads', parseChatSummary);
export const parseChatSummaryBody = (v: unknown): ChatSummary => parseChatSummary(v, 'thread');
export function parseChatThread(v: unknown): ChatThreadFull {
  const o = obj(v, 'body');
  const s = parseChatSummary({ ...o, messageCount: Array.isArray(o['messages']) ? (o['messages'] as unknown[]).length : 0 }, 'thread');
  return { ...s, messages: list(o['messages'], 'messages', parseChatMessage) };
}
export interface ChatReply {
  readonly threadId: string;
  readonly title: string;
  readonly userMessage: ChatMessage;
  readonly assistantMessage: ChatMessage;
}
export function parseChatReply(v: unknown): ChatReply {
  const o = obj(v, 'body');
  return {
    threadId: str(o['threadId'], 'threadId'),
    title: str(o['title'], 'title'),
    userMessage: parseChatMessage(o['userMessage'], 'userMessage'),
    assistantMessage: parseChatMessage(o['assistantMessage'], 'assistantMessage'),
  };
}

// ------------------------------------------------------------------ workflow drafts
export type DraftNodeKind = 'trigger' | 'compile' | 'validate' | 'capability' | 'branch' | 'human_review' | 'action';
export interface DraftNode {
  readonly id: string;
  readonly kind: DraftNodeKind;
  readonly label?: string;
  readonly config: Readonly<Record<string, unknown>>;
}
export interface DraftEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: 'gte' | 'lt';
}
export interface DraftIssue {
  readonly nodeId?: string;
  readonly message: string;
}
export interface DraftPlanStep {
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly executionClass: 'deterministic_rule' | 'human_in_the_loop';
  /** Approved in this workspace right now. The run itself re-checks it. */
  readonly approved: boolean;
}
export interface DraftPlanBranch {
  readonly nodeId: string;
  readonly capabilityId: string;
  /** The rule's declared contract confidence (fixed per rule), compared with the threshold. Not a measured per-run value. */
  readonly value: number;
  readonly threshold: number;
  readonly taken: 'gte' | 'lt';
}
/** The single path a run of this draft would take, as resolved by the platform. */
export interface DraftPlan {
  readonly compilationId: string;
  readonly path: readonly string[];
  readonly steps: readonly DraftPlanStep[];
  readonly branches: readonly DraftPlanBranch[];
}
export interface DraftAnalysis {
  readonly wellFormed: boolean;
  /** The platform's verdict: true only when the draft is well formed, has no blockers and its plan resolved. Never inferred here. */
  readonly runnable: boolean;
  readonly errors: readonly DraftIssue[];
  /** Why a well-formed draft still cannot run on this server. */
  readonly blockers: readonly DraftIssue[];
  readonly plan?: DraftPlan;
}
export interface WorkflowDraftSummary {
  readonly definitionId: string;
  readonly name: string;
  readonly revision: number;
  readonly nodeCount: number;
  readonly updatedAt: string;
}
export interface WorkflowDraft {
  readonly definitionId: string;
  readonly name: string;
  readonly revision: number;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
  readonly analysis: DraftAnalysis;
}
const issue = (v: unknown, path: string): DraftIssue => {
  const o = obj(v, path);
  const nodeId = optStr(o['nodeId'], `${path}.nodeId`);
  return { ...(nodeId !== undefined ? { nodeId } : {}), message: str(o['message'], `${path}.message`) };
};
const EXEC_CLASSES = new Set(['deterministic_rule', 'human_in_the_loop']);
function parsePlan(v: unknown, path: string): DraftPlan {
  const o = obj(v, path);
  return {
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    path: strArr(o['path'], `${path}.path`),
    steps: list(o['steps'], `${path}.steps`, (s, p) => {
      const x = obj(s, p);
      const klass = str(x['executionClass'], `${p}.executionClass`);
      if (!EXEC_CLASSES.has(klass)) throw new WireParseError(`${p}.executionClass`, 'a known execution class');
      return {
        nodeId: str(x['nodeId'], `${p}.nodeId`),
        capabilityId: str(x['capabilityId'], `${p}.capabilityId`),
        name: str(x['name'], `${p}.name`),
        executionClass: klass as DraftPlanStep['executionClass'],
        approved: bool(x['approved'], `${p}.approved`),
      };
    }),
    branches: list(o['branches'], `${path}.branches`, (b, p) => {
      const x = obj(b, p);
      if (str(x['basis'], `${p}.basis`) !== 'declared_contract_confidence')
        throw new WireParseError(`${p}.basis`, 'declared_contract_confidence');
      const taken = str(x['taken'], `${p}.taken`);
      if (taken !== 'gte' && taken !== 'lt') throw new WireParseError(`${p}.taken`, 'gte or lt');
      return {
        nodeId: str(x['nodeId'], `${p}.nodeId`),
        capabilityId: str(x['capabilityId'], `${p}.capabilityId`),
        value: num(x['value'], `${p}.value`),
        threshold: num(x['threshold'], `${p}.threshold`),
        taken,
      };
    }),
  };
}
export function parseAnalysis(v: unknown, path = 'analysis'): DraftAnalysis {
  const o = obj(v, path);
  const runnable = bool(o['runnable'], `${path}.runnable`);
  const plan = o['plan'] === undefined ? undefined : parsePlan(o['plan'], `${path}.plan`);
  // A runnable verdict without the plan it was derived from is not something to act on.
  if (runnable && plan === undefined) throw new WireParseError(`${path}.plan`, 'a plan whenever runnable is true');
  return {
    wellFormed: bool(o['wellFormed'], `${path}.wellFormed`),
    runnable,
    errors: list(o['errors'], `${path}.errors`, issue),
    blockers: list(o['blockers'], `${path}.blockers`, issue),
    ...(plan !== undefined ? { plan } : {}),
  };
}
export function parseDraft(v: unknown): WorkflowDraft {
  const o = obj(v, 'body');
  return {
    definitionId: str(o['definitionId'], 'definitionId'),
    name: str(o['name'], 'name'),
    revision: num(o['revision'], 'revision'),
    nodes: list(o['nodes'], 'nodes', (n, p) => {
      const x = obj(n, p);
      const label = optStr(x['label'], `${p}.label`);
      return {
        id: str(x['id'], `${p}.id`),
        kind: str(x['kind'], `${p}.kind`) as DraftNodeKind,
        ...(label !== undefined ? { label } : {}),
        config: obj(x['config'] ?? {}, `${p}.config`) as Json,
      };
    }),
    edges: list(o['edges'], 'edges', (e, p) => {
      const x = obj(e, p);
      const when = optStr(x['when'], `${p}.when`);
      return { from: str(x['from'], `${p}.from`), to: str(x['to'], `${p}.to`), ...(when === 'gte' || when === 'lt' ? { when } : {}) };
    }),
    analysis: parseAnalysis(o['analysis']),
  };
}
export const parseDraftList = (v: unknown): WorkflowDraftSummary[] =>
  list(obj(v, 'body')['definitions'], 'definitions', (d, p) => {
    const o = obj(d, p);
    return {
      definitionId: str(o['definitionId'], `${p}.definitionId`),
      name: str(o['name'], `${p}.name`),
      revision: num(o['revision'], `${p}.revision`),
      nodeCount: num(o['nodeCount'], `${p}.nodeCount`),
      updatedAt: str(o['updatedAt'], `${p}.updatedAt`),
    };
  });

// ------------------------------------------------------------------ capability preview
export interface CapabilityPreview {
  readonly approved: boolean;
  readonly testRunAllowed: boolean;
  readonly blockers: readonly string[];
  readonly note: string;
  readonly resolved: boolean;
  readonly bindingClass?: string;
  readonly externalEffects?: 'none' | 'creates_human_task';
  readonly inputIssues: readonly { readonly path: string; readonly message: string }[];
  readonly plan: readonly string[];
  readonly unresolvedReason?: string;
}
export function parseCapabilityPreview(v: unknown): CapabilityPreview {
  const o = obj(v, 'body');
  if (o['previewOnly'] !== true) throw new WireParseError('previewOnly', 'true (this response must declare itself a preview)');
  const p = o['preview'] === null || o['preview'] === undefined ? undefined : obj(o['preview'], 'preview');
  const kind = p !== undefined ? str(p['kind'], 'preview.kind') : undefined;
  const effects = p !== undefined ? optStr(p['externalEffects'], 'preview.externalEffects') : undefined;
  const reason = p !== undefined ? optStr(p['reason'], 'preview.reason') : undefined;
  return {
    approved: bool(o['approved'], 'approved'),
    testRunAllowed: bool(o['testRunAllowed'], 'testRunAllowed'),
    blockers: strArr(o['blockers'], 'blockers'),
    note: str(o['note'], 'note'),
    resolved: kind === 'ready',
    ...(kind === 'ready' && p !== undefined
      ? { bindingClass: str(obj(p['binding'], 'preview.binding')['implementationClass'], 'preview.binding.implementationClass') }
      : {}),
    ...(effects === 'none' || effects === 'creates_human_task' ? { externalEffects: effects } : {}),
    inputIssues:
      p !== undefined && p['inputIssues'] !== undefined
        ? list(p['inputIssues'], 'preview.inputIssues', (i, ip) => ({
            path: str(obj(i, ip)['path'], `${ip}.path`),
            message: str(obj(i, ip)['message'], `${ip}.message`),
          }))
        : [],
    plan: p !== undefined && p['plan'] !== undefined ? strArr(p['plan'], 'preview.plan') : [],
    ...(reason !== undefined ? { unresolvedReason: reason } : {}),
  };
}

// ------------------------------------------------------------------ node-kind support (what the platform can run)
export interface NodeKindVariant {
  readonly value: string;
  readonly supported: boolean;
  readonly reason?: string;
}
export interface NodeKindSupport {
  readonly kind: DraftNodeKind;
  readonly supported: boolean;
  readonly reason?: string;
  readonly note?: string;
  readonly variants: readonly NodeKindVariant[];
}
export const parseNodeKinds = (v: unknown): NodeKindSupport[] =>
  list(obj(v, 'body')['kinds'], 'kinds', (k, p) => {
    const o = obj(k, p);
    const reason = optStr(o['reason'], `${p}.reason`);
    const note = optStr(o['note'], `${p}.note`);
    return {
      kind: str(o['kind'], `${p}.kind`) as DraftNodeKind,
      supported: bool(o['supported'], `${p}.supported`),
      ...(reason !== undefined ? { reason } : {}),
      ...(note !== undefined ? { note } : {}),
      variants:
        o['variants'] === undefined
          ? []
          : list(o['variants'], `${p}.variants`, (x, vp) => {
              const vo = obj(x, vp);
              const vr = optStr(vo['reason'], `${vp}.reason`);
              return {
                value: str(vo['value'], `${vp}.value`),
                supported: bool(vo['supported'], `${vp}.supported`),
                ...(vr !== undefined ? { reason: vr } : {}),
              };
            }),
    };
  });

// ------------------------------------------------------------------ saved test cases
export type TestCaseStatus = 'succeeded' | 'waiting_for_human' | 'failed';
const CASE_STATUSES = new Set(['succeeded', 'waiting_for_human', 'failed']);
export interface TestCaseExpectation {
  readonly status: TestCaseStatus;
  readonly output?: Readonly<Record<string, unknown>>;
}
export interface TestCaseDraft {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: TestCaseExpectation;
}
export interface TestCaseRun {
  readonly runId: string;
  readonly caseId: string;
  readonly caseRevision: number;
  readonly executionId: string;
  readonly at: string;
  readonly ranBy: string;
  /** Decided by the platform from the persisted execution. Never computed in the browser. */
  readonly pass: boolean;
  readonly actual: { readonly status: string; readonly output?: unknown; readonly errorCode?: string; readonly errorMessage?: string };
  readonly mismatches: readonly string[];
}
export interface TestCase extends TestCaseDraft {
  readonly caseId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly lastRun?: TestCaseRun;
}
export function parseTestCaseRun(v: unknown, path = 'run'): TestCaseRun {
  const o = obj(v, path);
  const a = obj(o['actual'], `${path}.actual`);
  const errorCode = optStr(a['errorCode'], `${path}.actual.errorCode`);
  const errorMessage = optStr(a['errorMessage'], `${path}.actual.errorMessage`);
  return {
    runId: str(o['runId'], `${path}.runId`),
    caseId: str(o['caseId'], `${path}.caseId`),
    caseRevision: num(o['caseRevision'], `${path}.caseRevision`),
    executionId: str(o['executionId'], `${path}.executionId`),
    at: str(o['at'], `${path}.at`),
    ranBy: str(o['ranBy'], `${path}.ranBy`),
    pass: bool(o['pass'], `${path}.pass`),
    actual: {
      status: str(a['status'], `${path}.actual.status`),
      ...(a['output'] !== undefined ? { output: a['output'] } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
    mismatches: strArr(o['mismatches'], `${path}.mismatches`),
  };
}
export function parseTestCase(v: unknown, path = 'testCase'): TestCase {
  const o = obj(v, path);
  const e = obj(o['expected'], `${path}.expected`);
  const status = str(e['status'], `${path}.expected.status`);
  if (!CASE_STATUSES.has(status)) throw new WireParseError(`${path}.expected.status`, 'succeeded, waiting_for_human or failed');
  return {
    caseId: str(o['caseId'], `${path}.caseId`),
    compilationId: str(o['compilationId'], `${path}.compilationId`),
    capabilityId: str(o['capabilityId'], `${path}.capabilityId`),
    name: str(o['name'], `${path}.name`),
    input: obj(o['input'] ?? {}, `${path}.input`) as Json,
    expected: {
      status: status as TestCaseStatus,
      ...(e['output'] !== undefined ? { output: obj(e['output'], `${path}.expected.output`) as Json } : {}),
    },
    revision: num(o['revision'], `${path}.revision`),
    updatedAt: str(o['updatedAt'], `${path}.updatedAt`),
    ...(o['lastRun'] !== undefined ? { lastRun: parseTestCaseRun(o['lastRun'], `${path}.lastRun`) } : {}),
  };
}
export const parseTestCaseList = (v: unknown): TestCase[] => list(obj(v, 'body')['testCases'], 'testCases', (c, p) => parseTestCase(c, p));
export const parseTestCaseHistory = (v: unknown): TestCaseRun[] => list(obj(v, 'body')['runs'], 'runs', (r, p) => parseTestCaseRun(r, p));
export interface TestCaseBatch {
  readonly runs: readonly TestCaseRun[];
  readonly passed: number;
  readonly failed: number;
}
export function parseTestCaseBatch(v: unknown): TestCaseBatch {
  const o = obj(v, 'body');
  return {
    runs: list(o['runs'], 'runs', (r, p) => parseTestCaseRun(r, p)),
    passed: num(o['passed'], 'passed'),
    failed: num(o['failed'], 'failed'),
  };
}
