/**
 * The Studio-backend half of the test stand-in for @xo/api: members and roles, audit, settings, runtime status,
 * notifications, library, chat, workflow drafts, link import and capability preview. Same wire shapes as the real
 * server (those are proven against the real API by test/contract/studio-contract.test.ts), same role enforcement
 * (403 with the platform's permission code), same revision guard. The caller is an Admin unless a test says otherwise,
 * so every existing test keeps its full-access behaviour.
 */
import type { WorkspaceRole } from '../src/platform/wire';
import type { WorkspacePermission } from '../src/platform/wire-studio';

const GRANTS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  admin: ['read', 'author', 'publish', 'review', 'audit', 'manage'],
  publisher: ['read', 'author', 'publish'],
  reviewer: ['read', 'review', 'audit'],
  viewer: ['read'],
};

export interface FakeAudit {
  seq: number;
  at: string;
  event: string;
  result: string;
  actor: { identityId: string; kind: string; role?: string; displayName?: string };
  target?: { kind: string; id: string; label?: string };
}
export interface FakeLibraryItem {
  id: string;
  name: string;
  version: string;
  creatorDid: string;
  publishedAt: string;
  summary: string | null;
  capabilities: Array<{ id: string; name: string }>;
  madeByMe: boolean;
  signed: boolean;
  overallScore: number | null;
  byCategory: Record<string, number>;
  installable: boolean;
}
interface FakeChat {
  threadId: string;
  title: string;
  updatedAt: string;
  messages: Array<{
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    at: string;
    model?: { provider: string; model: string };
    attachedXos?: string[];
  }>;
}
export interface FakeCase {
  caseId: string;
  workspaceId: string;
  compilationId: string;
  capabilityId: string;
  name: string;
  input: Record<string, unknown>;
  expected: { status: string; output?: Record<string, unknown> };
  revision: number;
  updatedAt: string;
}
export interface FakeDraft {
  definitionId: string;
  name: string;
  revision: number;
  nodes: unknown[];
  edges: unknown[];
  updatedAt: string;
}
interface FakeInfo {
  requestId: string;
  question: string;
  requestedBy: string;
  requestedAt: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
}

type Reply = (status: number, data?: unknown) => Response;
type Err = (status: number, code: string, message: string) => Response;

export class StudioFake {
  role: WorkspaceRole = 'admin';
  /** What the platform TELLS Studio the role is; defaults to the real one. A test sets it differently to prove the server, not the UI hint, is authoritative. */
  reportedRole: WorkspaceRole | undefined;
  kind: 'team' | 'personal' = 'team';
  members: Array<{ identityId: string; role: WorkspaceRole; isOwner: boolean; displayName?: string; addedAt: string }> = [
    { identityId: 'owner', role: 'admin', isOwner: true, addedAt: '2026-10-01T09:00:00.000Z' },
    { identityId: 'meera-identity', role: 'reviewer', isOwner: false, displayName: 'Meera', addedAt: '2026-10-02T09:00:00.000Z' },
  ];
  audit: FakeAudit[] = [
    {
      seq: 1,
      at: '2026-10-20T10:00:00.000Z',
      event: 'workspace.created',
      result: 'succeeded',
      actor: { identityId: 'owner', kind: 'user', role: 'admin' },
    },
    {
      seq: 2,
      at: '2026-10-20T10:05:00.000Z',
      event: 'source.uploaded',
      result: 'succeeded',
      actor: { identityId: 'owner', kind: 'user', role: 'admin' },
      target: { kind: 'source', id: 'src_1', label: 'policy.pdf' },
    },
    {
      seq: 3,
      at: '2026-10-21T08:00:00.000Z',
      event: 'access.denied',
      result: 'denied',
      actor: { identityId: 'meera-identity', kind: 'user', role: 'reviewer', displayName: 'Meera' },
    },
  ];
  chainOk = true;
  retentionDays: number | null = null;
  settings = {
    revision: 0,
    runtime: { location: 'this_computer' },
    model: { primary: null as { provider: string; model: string } | null, fallback: null as { provider: string; model: string } | null },
    airGapped: false,
    trust: { requireSignedPackages: false },
    notifications: { onEscalation: true, onRunFailure: true, onWorkflowComplete: false },
    region: null as string | null,
  };
  providers = [
    { id: 'anthropic', configured: true, local: false },
    { id: 'openai', configured: false, local: false },
    { id: 'ollama', configured: false, local: true },
  ];
  availableLocations = ['this_computer'];
  runtime = { status: 'online', mountedPackages: 1, capabilityCount: 3, warnings: [] as string[], modelUsable: false };
  /** Makes the NEXT settings write look like someone else changed them first. */
  staleNextSettingsWrite = false;
  notifications: Array<{ seq: number; at: string; kind: string; event: string; read: boolean }> = [];
  library: FakeLibraryItem[] = [];
  installs: Array<{ name: string; version: string }> = [];
  chats: FakeChat[] = [];
  /** What the platform's model returns, or an error status to simulate a failure. */
  chatReply: string | { fail: number; code: string; message: string } = 'Here is an answer.';
  drafts: FakeDraft[] = [];
  /** definitionIds a run was actually started for (a test asserts none was started when the platform refused). */
  runsStarted: string[] = [];
  nodeKinds: Array<{
    kind: string;
    supported: boolean;
    reason?: string;
    note?: string;
    variants?: Array<{ value: string; supported: boolean; reason?: string }>;
  }> = [
    {
      kind: 'trigger',
      supported: true,
      variants: [
        { value: 'manual', supported: true },
        { value: 'schedule', supported: false, reason: 'There is no scheduler; schedule triggers cannot fire.' },
        {
          value: 'document_dropped',
          supported: false,
          reason: 'There is no folder or drop watcher; "document dropped" triggers cannot fire.',
        },
      ],
    },
    {
      kind: 'capability',
      supported: true,
      note: 'Must name the succeeded compilation it comes from.',
      variants: [
        { value: 'none', supported: true },
        {
          value: 'workflow',
          supported: false,
          reason: 'Capability memory scopes are not part of the runtime; only "none" can be honored.',
        },
        {
          value: 'workspace',
          supported: false,
          reason: 'Capability memory scopes are not part of the runtime; only "none" can be honored.',
        },
      ],
    },
    { kind: 'branch', supported: true, note: 'Compares the capability directly before it by its declared contract confidence.' },
    { kind: 'human_review', supported: true, note: 'Only directly after a rule that itself asks a person.' },
    { kind: 'compile', supported: false, reason: 'Nothing here runs the compiler on demand from inside a workflow.' },
    { kind: 'validate', supported: false, reason: 'Nothing here runs the validator on demand from inside a workflow.' },
    {
      kind: 'action',
      supported: false,
      reason: 'There is no webhook or email delivery; action steps cannot run.',
      variants: [
        { value: 'webhook', supported: false, reason: 'There is no webhook delivery.' },
        { value: 'email', supported: false, reason: 'There is no email delivery.' },
      ],
    },
  ];
  /** Approved capability keys (`compilationId:capabilityId`), mirrored from FakeXo for the plan's `approved` flags. */
  approvedIds: ReadonlySet<string> = new Set();
  testCases = new Map<string, FakeCase[]>();
  /** Cases that already exist when a capability's list is first read (so a test can start as a role that cannot create them). */
  seedCases: Array<Partial<FakeCase>> = [];
  caseRuns = new Map<string, Array<Record<string, unknown>>>();
  /** What a case's real execution would record. Tests override it to produce failures, mismatches and human tasks. */
  caseOutcome: (c: FakeCase) => { status: string; output?: Record<string, unknown>; errorCode?: string; errorMessage?: string } = () => ({
    status: 'succeeded',
    output: { matched: true, outcome: 'covered' },
  });
  infoRequests = new Map<string, FakeInfo[]>();
  /** Human tasks the platform's inbox reports (a test seeds these alongside the matching execution/run). */
  inbox: Array<{
    executionId: string;
    title: string;
    state: 'needs_review' | 'done';
    decision?: string;
    resolvedAt?: string;
    resolverIdentityId?: string;
    capabilityId?: string;
    compilationId?: string;
    sourceFilename?: string;
  }> = [];
  importResult: { originalFilename: string } | { fail: number; code: string; message: string } = { originalFilename: 'terms.txt' };
  /** Result of a capability preview, keyed by capability id; a default "resolved, not approved" preview otherwise. */
  previews = new Map<string, Record<string, unknown>>();
  private n = 100;

  /** Added to every workspace the base fake returns, so the UI knows the caller's role. */
  workspaceMeta(): Record<string, unknown> {
    return { kind: this.kind, memberCount: this.members.length, role: this.reportedRole ?? this.role };
  }

  private allowed(p: WorkspacePermission): boolean {
    return GRANTS[this.role].includes(p);
  }
  private note(event: string, result = 'succeeded', target?: FakeAudit['target']): void {
    this.audit.push({
      seq: this.audit.length + 1,
      at: new Date().toISOString(),
      event,
      result,
      actor: { identityId: 'owner', kind: 'user', role: this.role },
      ...(target !== undefined ? { target } : {}),
    });
  }

  handle(
    method: string,
    fullPath: string,
    body: Record<string, unknown>,
    reply: Reply,
    err: Err,
    ctx: {
      approvedIds: ReadonlySet<string>;
      /** Records a run the way the platform's runner would (supplied by FakeXo, which owns the run list). */
      startDraftRun?: (draft: FakeDraft, plan: Record<string, any>, body: Record<string, unknown>) => Response;
    },
  ): Response | undefined {
    const [path = '', qs = ''] = fullPath.split('?');
    const q = new URLSearchParams(qs);
    const deny = (p: WorkspacePermission, doing: string): Response | undefined =>
      this.allowed(p)
        ? undefined
        : (this.note('access.denied', 'denied'),
          err(403, 'XO_RUNTIME_PERMISSION_DENIED', `role "${this.role}" does not have the "${p}" permission in this workspace (${doing})`));
    this.approvedIds = ctx.approvedIds;
    const base = /^\/workspaces\/[^/]+/;
    if (method === 'GET' && path === '/regions')
      return reply(200, {
        regions: [
          { id: 'in-mumbai', label: 'India (Mumbai)' },
          { id: 'eu-frankfurt', label: 'EU (Frankfurt)' },
        ],
      });
    if (!base.test(path)) return undefined;
    const rest = path.replace(base, '');
    let m: RegExpMatchArray | null;

    // ---- members
    if (method === 'GET' && rest === '/members') {
      const counts = { admin: 0, publisher: 0, reviewer: 0, viewer: 0 } as Record<WorkspaceRole, number>;
      for (const x of this.members) counts[x.role]++;
      return reply(200, {
        members: this.members,
        total: this.members.length,
        roleCounts: counts,
        callerRole: this.role,
        callerPermissions: GRANTS[this.role],
      });
    }
    if (method === 'POST' && rest === '/members') {
      const d = deny('manage', 'add member');
      if (d) return d;
      if (this.members.some((x) => x.identityId === body['identityId']))
        return err(409, 'XO_ALREADY_EXISTS', 'identity already has access to this workspace');
      const member = {
        identityId: String(body['identityId']),
        role: body['role'] as WorkspaceRole,
        isOwner: false,
        ...(typeof body['displayName'] === 'string' ? { displayName: body['displayName'] } : {}),
        addedAt: new Date().toISOString(),
      };
      this.members.push(member);
      this.note('member.added', 'succeeded', { kind: 'member', id: member.identityId });
      return reply(201, { member });
    }
    if ((method === 'PATCH' || method === 'DELETE') && (m = rest.match(/^\/members\/([^/]+)$/))) {
      const d = deny('manage', 'change member');
      if (d) return d;
      const id = decodeURIComponent(m[1]!);
      const target = this.members.find((x) => x.identityId === id);
      if (target === undefined) return err(404, 'XO_NOT_FOUND', `member "${id}" not found`);
      if (target.isOwner) return err(412, 'XO_PRECONDITION_FAILED', 'the workspace owner cannot be changed');
      if (method === 'PATCH') {
        target.role = body['role'] as WorkspaceRole;
        this.note('member.role_changed', 'succeeded', { kind: 'member', id });
        return reply(200, { member: target });
      }
      this.members = this.members.filter((x) => x !== target);
      this.note('member.removed', 'succeeded', { kind: 'member', id });
      return reply(200, { removed: id });
    }

    // ---- audit
    if (method === 'GET' && rest === '/audit/events') {
      const d = deny('audit', 'read audit log');
      if (d) return d;
      const event = q.get('event');
      const since = q.get('since');
      const before = q.get('before') === null ? Infinity : Number(q.get('before'));
      const limit = Number(q.get('limit') ?? 50);
      const all = [...this.audit]
        .reverse()
        .filter((e) => (event === null || e.event === event) && (since === null || e.at >= since) && e.seq < before);
      const page = all.slice(0, limit);
      return reply(200, { events: page, ...(all.length > limit ? { nextBefore: page[page.length - 1]!.seq } : {}) });
    }
    if (method === 'GET' && rest === '/audit/verify') {
      const d = deny('audit', 'verify audit log');
      if (d) return d;
      return reply(200, {
        ok: this.chainOk,
        entries: this.audit.length,
        headHash: 'sha256:abc',
        ...(this.chainOk ? {} : { brokenAt: { seq: 2, reason: 'bad_hash' } }),
        appendOnly: true,
        tamperEvident: true,
        retention: { minimumDays: this.retentionDays, deletionSupported: false },
      });
    }
    if (method === 'GET' && rest.startsWith('/audit/export')) {
      const d = deny('manage', 'export audit log');
      if (d) return d;
      this.note('audit.exported');
      return new Response(
        q.get('format') === 'csv' ? 'seq,at,actor\n1,x,y\n' : JSON.stringify({ format: 'xo-audit-evidence/1', entries: this.audit }),
        { status: 200 },
      );
    }

    // ---- settings and runtime
    if (method === 'GET' && rest === '/settings') return reply(200, this.settingsView());
    if (method === 'PUT' && rest === '/settings') {
      const d = deny('manage', 'update settings');
      if (d) return d;
      if (this.staleNextSettingsWrite) {
        // Someone else saved first: the revision the caller loaded is now behind.
        this.staleNextSettingsWrite = false;
        this.settings.revision += 1;
      }
      if (typeof body['expectedRevision'] === 'number' && body['expectedRevision'] !== this.settings.revision) {
        return reply(412, {
          error: {
            code: 'XO_PRECONDITION_FAILED',
            message: 'settings were changed by someone else',
            context: { reason: 'stale_revision' },
          },
        });
      }
      const model = body['model'] as { primary?: unknown; fallback?: unknown } | undefined;
      const air = typeof body['airGapped'] === 'boolean' ? body['airGapped'] : this.settings.airGapped;
      type Choice = { provider: string; model: string } | null;
      const primary = model?.primary !== undefined ? (model.primary as Choice) : this.settings.model.primary;
      const fallback = model?.fallback !== undefined ? (model.fallback as Choice) : this.settings.model.fallback;
      const offBox = [primary, fallback].find((c) => c !== null && !this.providers.find((p) => p.id === c.provider)?.local);
      if (air && offBox) return err(412, 'XO_PRECONDITION_FAILED', `air-gapped mode forbids the off-box provider "${offBox.provider}"`);
      const loc = (body['runtime'] as { location?: string } | undefined)?.location;
      if (loc !== undefined && !this.availableLocations.includes(loc))
        return err(412, 'XO_PRECONDITION_FAILED', `runtime location "${loc}" is not available on this deployment`);
      this.settings.model = { primary, fallback };
      this.settings.airGapped = air;
      if (loc !== undefined) this.settings.runtime = { location: loc };
      if (typeof body['region'] === 'string') this.settings.region = body['region'];
      const trust = body['trust'] as { requireSignedPackages?: boolean } | undefined;
      if (trust?.requireSignedPackages !== undefined) this.settings.trust.requireSignedPackages = trust.requireSignedPackages;
      if (body['notifications'] !== undefined)
        this.settings.notifications = { ...this.settings.notifications, ...(body['notifications'] as object) };
      this.settings.revision += 1;
      this.note('settings.updated');
      return reply(200, this.settingsView());
    }
    if (method === 'GET' && rest === '/runtime/status') {
      return reply(200, {
        status: this.runtime.status,
        location: this.settings.runtime.location,
        checkedAt: new Date().toISOString(),
        bootstrapMs: 3,
        runtime: {
          mountedPackages: this.runtime.mountedPackages,
          capabilityCount: this.runtime.capabilityCount,
          warnings: this.runtime.warnings,
        },
        model: { usable: this.runtime.modelUsable },
        airGapped: this.settings.airGapped,
      });
    }

    // ---- notifications
    if (method === 'GET' && rest === '/notifications') {
      const visible = this.notifications.map((x) => ({ ...x, actorIdentityId: 'owner' }));
      return reply(200, { notifications: visible, unread: visible.filter((x) => !x.read).length, readThroughSeq: 0, delivery: 'in_app' });
    }
    if (method === 'POST' && rest === '/notifications/read') {
      for (const x of this.notifications) if (x.seq <= Number(body['throughSeq'])) x.read = true;
      return reply(200, { readThroughSeq: Number(body['throughSeq']) });
    }

    // ---- inbox
    const inboxItem = (t: (typeof this.inbox)[number]) => ({
      executionId: t.executionId,
      state: t.state,
      title: t.title,
      capabilityId: t.capabilityId ?? 'cap_x',
      compilationId: t.compilationId ?? 'cmp_x',
      ...(t.sourceFilename !== undefined ? { sourceFilename: t.sourceFilename } : {}),
      requestedAt: '2026-10-22T09:00:00.000Z',
      ...(t.resolvedAt !== undefined ? { resolvedAt: t.resolvedAt } : {}),
      ...(t.decision !== undefined ? { decision: t.decision } : {}),
      ...(t.resolverIdentityId !== undefined ? { resolverIdentityId: t.resolverIdentityId } : {}),
      openInfoRequests: (this.infoRequests.get(t.executionId) ?? []).filter((r) => r.answer === undefined).length,
    });
    if (method === 'GET' && rest === '/inbox') {
      const state = q.get('state');
      const items = this.inbox.filter((t) => state === null || t.state === state).map(inboxItem);
      return reply(200, {
        items,
        counts: {
          needsReview: this.inbox.filter((t) => t.state === 'needs_review').length,
          done: this.inbox.filter((t) => t.state === 'done').length,
        },
      });
    }
    if ((m = rest.match(/^\/inbox\/([^/]+)$/)) && method === 'GET') {
      const t = this.inbox.find((x) => x.executionId === m![1]);
      if (t === undefined) return err(404, 'XO_NOT_FOUND', 'human task not found');
      return reply(200, { ...inboxItem(t), input: {}, escalation: {}, infoRequests: this.infoRequests.get(t.executionId) ?? [] });
    }
    if (method === 'POST' && (m = rest.match(/^\/inbox\/([^/]+)\/info-requests$/))) {
      const d = deny('review', 'request more information');
      if (d) return d;
      const t = this.inbox.find((x) => x.executionId === m![1]);
      if (t === undefined) return err(404, 'XO_NOT_FOUND', 'human task not found');
      if (t.state === 'done')
        return err(412, 'XO_PRECONDITION_FAILED', 'this task is already resolved; more information can no longer be requested');
      const info: FakeInfo = {
        requestId: `ir_${++this.n}`,
        question: String(body['question']),
        requestedBy: 'owner',
        requestedAt: new Date().toISOString(),
      };
      this.infoRequests.set(t.executionId, [...(this.infoRequests.get(t.executionId) ?? []), info]);
      this.note('human_task.info_requested', 'succeeded', { kind: 'human_task', id: t.executionId });
      return reply(201, info);
    }
    if (method === 'POST' && (m = rest.match(/^\/inbox\/([^/]+)\/info-requests\/([^/]+)\/answer$/))) {
      const d = deny('author', 'answer information request');
      if (d) return d;
      const list = this.infoRequests.get(m[1]!) ?? [];
      const target = list.find((r) => r.requestId === m![2]);
      if (target === undefined) return err(404, 'XO_NOT_FOUND', 'information request not found');
      if (target.answer !== undefined) return err(409, 'XO_ALREADY_EXISTS', 'this information request already has an answer');
      Object.assign(target, { answer: String(body['answer']), answeredBy: 'owner', answeredAt: new Date().toISOString() });
      return reply(200, target);
    }

    // ---- library
    if (method === 'GET' && rest === '/library') {
      const scope = q.get('scope') ?? 'all';
      const text = (q.get('q') ?? '').toLowerCase();
      const items = this.library.filter((i) => text === '' || i.name.toLowerCase().includes(text)).map((i) => this.libItem(i));
      return reply(200, {
        items: items.filter((i) => (scope === 'installed' ? i.installed : scope === 'mine' ? i.madeByMe : true)),
        counts: { all: items.length, installed: items.filter((i) => i.installed).length, mine: items.filter((i) => i.madeByMe).length },
        catalog: 'workspace',
      });
    }
    if (method === 'GET' && (m = rest.match(/^\/library\/packages\/([^/]+)$/))) {
      const item = this.library.find((i) => i.id === decodeURIComponent(m![1]!));
      if (item === undefined) return err(404, 'XO_NOT_FOUND', 'package not found');
      return reply(200, {
        ...this.libItem(item),
        benchmarks: {
          overall: item.overallScore,
          byCategory: item.byCategory,
          runs: Object.keys(item.byCategory).length,
          lastRunAt: null,
          independentlyVerified: false,
        },
        signatures: item.signed ? [{ signerDid: 'did:xo:signer', role: 'creator' }] : [],
        installable: item.installable,
      });
    }
    if (method === 'GET' && rest === '/library/installs') return reply(200, { installs: this.installs });
    if (method === 'POST' && rest === '/library/installs') {
      const d = deny('author', 'install package');
      if (d) return d;
      const item = this.library.find((i) => i.id === body['packageId']);
      if (item === undefined) return err(404, 'XO_NOT_FOUND', 'package not found');
      if (!item.installable)
        return err(
          412,
          'XO_PRECONDITION_FAILED',
          'the original package archive was not retained for this package; re-publish it to make it installable',
        );
      if (this.settings.trust.requireSignedPackages && !item.signed)
        return err(
          412,
          'XO_PRECONDITION_FAILED',
          'this workspace requires signed packages (Settings → Trust and signing); this package carries no signature entries',
        );
      if (this.installs.some((i) => i.name === item.name && i.version === item.version))
        return err(409, 'XO_PACKAGE_ALREADY_INSTALLED', 'already installed');
      this.installs.push({ name: item.name, version: item.version });
      this.note('xo.installed', 'succeeded', { kind: 'xo', id: item.id, label: item.name });
      return reply(201, { name: item.name, version: item.version });
    }
    if (method === 'DELETE' && (m = rest.match(/^\/library\/installs\/([^/]+)\/([^/]+)$/))) {
      const d = deny('author', 'uninstall package');
      if (d) return d;
      this.installs = this.installs.filter((i) => !(i.name === decodeURIComponent(m![1]!) && i.version === decodeURIComponent(m![2]!)));
      return reply(200, { uninstalled: `${m[1]}@${m[2]}` });
    }

    // ---- link import
    if (method === 'POST' && rest === '/sources/import') {
      const d = deny('author', 'import source');
      if (d) return d;
      if (this.settings.airGapped)
        return err(
          412,
          'XO_PRECONDITION_FAILED',
          'this workspace is in air-gapped mode: importing from a link is disabled (upload the file instead)',
        );
      if ('fail' in this.importResult) return err(this.importResult.fail, this.importResult.code, this.importResult.message);
      const src = {
        sourceId: `src_${++this.n}`,
        originalFilename: this.importResult.originalFilename,
        mediaType: 'text/plain',
        extension: '.txt',
        byteSize: 40,
        status: 'stored',
        createdAt: new Date().toISOString(),
        origin: { kind: 'url', url: String(body['url']).split('?')[0] },
      };
      this.importedSources.push(src);
      return reply(201, src);
    }

    // ---- chat
    if (method === 'GET' && rest === '/chats')
      return reply(200, {
        threads: this.chats.map((c) => ({ threadId: c.threadId, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })),
      });
    if (method === 'POST' && rest === '/chats') {
      const c: FakeChat = {
        threadId: `cht_${String(++this.n).padStart(32, '0')}`,
        title: typeof body['title'] === 'string' ? body['title'] : 'New chat',
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      this.chats.unshift(c);
      return reply(201, { threadId: c.threadId, title: c.title, updatedAt: c.updatedAt, messageCount: 0, messages: [] });
    }
    if ((m = rest.match(/^\/chats\/([^/]+)$/))) {
      const c = this.chats.find((x) => x.threadId === m![1]);
      if (c === undefined) return err(404, 'XO_NOT_FOUND', 'chat not found');
      if (method === 'GET') return reply(200, { threadId: c.threadId, title: c.title, updatedAt: c.updatedAt, messages: c.messages });
      if (method === 'DELETE') {
        this.chats = this.chats.filter((x) => x !== c);
        return reply(200, { deleted: c.threadId });
      }
    }
    if (method === 'POST' && (m = rest.match(/^\/chats\/([^/]+)\/messages$/))) {
      const c = this.chats.find((x) => x.threadId === m![1]);
      if (c === undefined) return err(404, 'XO_NOT_FOUND', 'chat not found');
      if (typeof this.chatReply !== 'string') return err(this.chatReply.fail, this.chatReply.code, this.chatReply.message);
      const at = new Date().toISOString();
      const attach = Array.isArray(body['attach']) ? (body['attach'] as string[]) : undefined;
      const user = {
        messageId: `msg_${++this.n}`,
        role: 'user' as const,
        content: String(body['content']),
        at,
        ...(attach !== undefined ? { attachedXos: attach } : {}),
      };
      const bot = {
        messageId: `msg_${++this.n}`,
        role: 'assistant' as const,
        content: this.chatReply,
        at,
        model: { provider: 'anthropic', model: 'test-model' },
      };
      if (c.messages.length === 0 && c.title === 'New chat') c.title = user.content.slice(0, 60);
      c.messages.push(user, bot);
      c.updatedAt = at;
      return reply(201, { threadId: c.threadId, title: c.title, userMessage: user, assistantMessage: bot });
    }

    // ---- workflow drafts
    if (method === 'GET' && rest === '/workflow-definitions')
      return reply(200, {
        definitions: this.drafts.map((d) => ({
          definitionId: d.definitionId,
          name: d.name,
          status: 'draft',
          revision: d.revision,
          nodeCount: d.nodes.length,
          updatedAt: d.updatedAt,
          updatedBy: 'owner',
        })),
      });
    if (method === 'POST' && rest === '/workflow-definitions/validate') return reply(200, this.analysis(body));
    if (method === 'POST' && rest === '/workflow-definitions') {
      const d = deny('author', 'save workflow');
      if (d) return d;
      const draft: FakeDraft = {
        definitionId: `wfd_${String(++this.n).padStart(32, '0')}`,
        name: String(body['name']),
        revision: 1,
        nodes: body['nodes'] as unknown[],
        edges: body['edges'] as unknown[],
        updatedAt: new Date().toISOString(),
      };
      this.drafts.push(draft);
      this.note('workflow.definition_saved', 'succeeded', { kind: 'workflow_definition', id: draft.definitionId });
      return reply(201, this.draftView(draft));
    }
    if (method === 'GET' && rest === '/workflow-definitions/node-kinds') return reply(200, { kinds: this.nodeKinds });
    if (method === 'POST' && (m = rest.match(/^\/workflow-definitions\/([^/]+)\/run$/))) {
      const d = deny('author', 'run workflow');
      if (d) return d;
      const draft = this.drafts.find((x) => x.definitionId === m![1]);
      if (draft === undefined) return err(404, 'XO_NOT_FOUND', 'workflow definition not found');
      if (typeof body['expectedRevision'] === 'number' && body['expectedRevision'] !== draft.revision)
        return reply(409, {
          error: {
            code: 'XO_RUNTIME_SESSION_INVALID_STATE',
            message: 'stale draft revision; nothing was run',
            context: { reason: 'stale_revision' },
          },
        });
      const a = this.analysis(draft as unknown as Record<string, unknown>);
      if (!a.runnable || a.plan === undefined)
        return reply(501, {
          error: {
            code: 'XO_UNIMPLEMENTED',
            message: 'This draft cannot run on this server. analysis.blockers and analysis.errors say exactly why; nothing was started.',
          },
          analysis: a,
        });
      this.runsStarted.push(draft.definitionId);
      return ctx.startDraftRun !== undefined ? ctx.startDraftRun(draft, a.plan, body) : err(500, 'XO_INTERNAL', 'fake has no run list');
    }
    // ---- saved test cases
    if ((m = rest.match(/^\/compilations\/([^/]+)\/capabilities\/([^/]+)\/test-case(s|-runs)(?:\/([^/]+))?(\/runs)?$/))) {
      const [, cid, cap, kind, caseId, runs] = m as unknown as [string, string, string, string, string | undefined, string | undefined];
      const key = `${cid}:${cap}`;
      if (!this.testCases.has(key) && this.seedCases.length > 0)
        this.testCases.set(
          key,
          this.seedCases.map(
            (c, i) =>
              ({
                caseId: `tc_seed${i}`,
                workspaceId: 'ws_1',
                compilationId: cid,
                capabilityId: cap,
                revision: 1,
                updatedAt: '2026-10-01T00:00:00.000Z',
                input: {},
                expected: { status: 'succeeded' },
                ...c,
              }) as FakeCase,
          ),
        );
      const mine = (this.testCases.get(key) ?? []) as FakeCase[];
      const view = (c: FakeCase) => ({
        ...c,
        ...(this.caseRuns.get(c.caseId)?.[0] !== undefined ? { lastRun: this.caseRuns.get(c.caseId)![0] } : {}),
      });
      const canRun = this.allowed('author') || this.allowed('review');
      const refuseRun = () => (
        this.note('access.denied', 'denied'),
        err(
          403,
          'XO_RUNTIME_PERMISSION_DENIED',
          `role "${this.role}" does not have the "review" permission in this workspace (run test case)`,
        )
      );
      const execute = (c: FakeCase): Response => {
        if (!ctx.approvedIds.has(key))
          return err(403, 'XO_RUNTIME_PERMISSION_DENIED', `capability "${cap}" is not approved for execution in workspace "ws_1"`);
        const actual = this.caseOutcome(c);
        const mismatches: string[] = [];
        if (actual.status !== c.expected.status) mismatches.push(`status: expected "${c.expected.status}", got "${actual.status}"`);
        for (const [k, v] of Object.entries(c.expected.output ?? {}))
          if (JSON.stringify((actual.output as Record<string, unknown> | undefined)?.[k]) !== JSON.stringify(v))
            mismatches.push(
              `output.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify((actual.output as Record<string, unknown> | undefined)?.[k])}`,
            );
        const run = {
          runId: `tcr_${++this.n}`,
          caseId: c.caseId,
          caseRevision: c.revision,
          executionId: `exe_tc_${this.n}`,
          at: new Date().toISOString(),
          ranBy: 'sally',
          pass: mismatches.length === 0,
          actual,
          mismatches,
        };
        this.caseRuns.set(c.caseId, [run, ...(this.caseRuns.get(c.caseId) ?? [])]);
        return reply(200, run);
      };
      if (kind === '-runs') {
        if (!canRun) return refuseRun();
        const ids = Array.isArray(body['caseIds']) ? (body['caseIds'] as string[]) : undefined;
        const chosen = ids === undefined ? mine : mine.filter((c) => ids.includes(c.caseId));
        const out: unknown[] = [];
        for (const c of chosen) {
          const r = execute(c);
          if (r.status !== 200) return r;
          out.push(this.caseRuns.get(c.caseId)![0]);
        }
        const passed = out.filter((r) => (r as { pass: boolean }).pass).length;
        return reply(200, { runs: out, passed, failed: out.length - passed });
      }
      if (caseId === undefined) {
        if (method === 'GET') return reply(200, { testCases: mine.map(view) });
        if (method === 'POST') {
          const d = deny('author', 'save test case');
          if (d) return d;
          const c: FakeCase = {
            caseId: `tc_${String(++this.n).padStart(32, '0')}`,
            workspaceId: 'ws_1',
            compilationId: cid,
            capabilityId: cap,
            name: String(body['name']),
            input: (body['input'] as Record<string, unknown>) ?? {},
            expected: body['expected'] as FakeCase['expected'],
            revision: 1,
            updatedAt: new Date().toISOString(),
          };
          this.testCases.set(key, [...mine, c]);
          return reply(201, c);
        }
      } else {
        const c = mine.find((x) => x.caseId === caseId);
        if (c === undefined) return err(404, 'XO_NOT_FOUND', `test case "${caseId}" was not found`);
        if (runs === '/runs') {
          if (method === 'GET') return reply(200, { runs: this.caseRuns.get(caseId) ?? [] });
          if (method === 'POST') return canRun ? execute(c) : refuseRun();
        }
        if (method === 'GET') return reply(200, view(c));
        const d = deny('author', 'change test case');
        if (d) return d;
        if (method === 'PUT') {
          if (typeof body['expectedRevision'] === 'number' && body['expectedRevision'] !== c.revision)
            return reply(412, {
              error: {
                code: 'XO_PRECONDITION_FAILED',
                message: 'this test case was changed by someone else',
                context: { reason: 'stale_revision' },
              },
            });
          Object.assign(c, {
            name: String(body['name']),
            input: body['input'] ?? {},
            expected: body['expected'],
            revision: c.revision + 1,
            updatedAt: new Date().toISOString(),
          });
          return reply(200, c);
        }
        if (method === 'DELETE') {
          this.testCases.set(
            key,
            mine.filter((x) => x !== c),
          );
          this.caseRuns.delete(caseId);
          return reply(200, { deleted: true });
        }
      }
    }
    if ((m = rest.match(/^\/workflow-definitions\/([^/]+)$/))) {
      const draft = this.drafts.find((x) => x.definitionId === m![1]);
      if (draft === undefined) return err(404, 'XO_NOT_FOUND', 'workflow definition not found');
      if (method === 'GET') return reply(200, this.draftView(draft));
      const d = deny('author', 'change workflow');
      if (d) return d;
      if (method === 'PUT') {
        if (typeof body['expectedRevision'] === 'number' && body['expectedRevision'] !== draft.revision) {
          return reply(412, {
            error: {
              code: 'XO_PRECONDITION_FAILED',
              message: 'this workflow was changed by someone else',
              context: { reason: 'stale_revision' },
            },
          });
        }
        Object.assign(draft, {
          name: String(body['name']),
          nodes: body['nodes'],
          edges: body['edges'],
          revision: draft.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        return reply(200, this.draftView(draft));
      }
      if (method === 'DELETE') {
        this.drafts = this.drafts.filter((x) => x !== draft);
        return reply(200, { deleted: draft.definitionId });
      }
    }

    // ---- capability preview
    if (method === 'POST' && (m = rest.match(/^\/compilations\/([^/]+)\/capabilities\/([^/]+)\/preview$/))) {
      const d = deny('author', 'preview capability');
      if (d) return d;
      const approved = ctx.approvedIds.has(`${m[1]}:${m[2]}`);
      const custom = this.previews.get(m[2]!);
      const blockers = approved ? [] : ['the capability is not approved; a Test Run uses the same approval gate as a production run'];
      const preview = custom ?? {
        kind: 'ready',
        contract: {},
        binding: { id: 'b', implementationClass: 'deterministic_rule', resolverName: 'r', description: '' },
        inputSchemaDeclared: true,
        inputIssues: [],
        plan: [
          'Check the compilation succeeded and the capability is approved (a real run is refused otherwise).',
          'Evaluate the deterministic rules over the input and return the result; no external system is called.',
        ],
        externalEffects: 'none',
      };
      const issues = ((preview as { inputIssues?: unknown[] }).inputIssues ?? []).length;
      if (issues > 0) blockers.push('the input does not satisfy the declared input schema');
      return reply(200, {
        previewOnly: true,
        note: 'Nothing was executed, no execution record was written and no human task was opened. A passing preview does not prove the real run will succeed.',
        compilationId: m[1],
        capabilityId: m[2],
        approved,
        testRunAllowed: blockers.length === 0,
        blockers,
        preview,
      });
    }
    return undefined;
  }

  importedSources: Array<Record<string, unknown>> = [];

  private settingsView() {
    return {
      settings: { ...this.settings, residency: { region: this.settings.region } },
      effect: {
        runtime: { enforced: false, note: 'n', availableLocations: this.availableLocations },
        model: { enforced: true, note: 'n', providers: this.providers },
        airGapped: { enforced: true, note: 'n' },
        residency: {
          enforced: false,
          declared: this.settings.region,
          label: null,
          note: 'Declarative. It is recorded on the workspace and in audit exports; the server does not prove or control where bytes are physically stored.',
        },
        trust: {
          requireSignedPackages: {
            enforced: true,
            note: 'Registry publish and XO install refuse a package whose manifest carries NO signature entries. This is a presence check only: this server has no signer-key resolution or trust anchors, so it does not verify that any signature is valid or who made it. Do not treat it as proof of authenticity.',
          },
          requireCompilerAttestation: { enforced: false, available: false, note: 'n' },
        },
        notifications: { enforced: true, delivery: 'in_app', note: 'n' },
        settingsRevision: this.settings.revision,
      },
    };
  }
  private libItem(i: FakeLibraryItem) {
    return {
      id: i.id,
      name: i.name,
      version: i.version,
      creatorDid: i.creatorDid,
      publishedAt: i.publishedAt,
      summary: i.summary,
      capabilities: i.capabilities,
      installed: this.installs.some((x) => x.name === i.name && x.version === i.version),
      madeByMe: i.madeByMe,
      trust: {
        signed: i.signed,
        signerCount: i.signed ? 1 : 0,
        signaturesVerified: false,
        benchmarked: i.overallScore !== null,
        overallScore: i.overallScore,
        independentlyVerified: false,
      },
    };
  }
  /** A stand-in for the platform's analysis with the same rules (one manual trigger, supported kinds only, capabilities name a compilation, a branch follows a capability). The real behaviour is checked by the contract test. */
  private analysis(d: Record<string, unknown>) {
    const nodes = (d['nodes'] as Array<{ id: string; kind: string; config?: Record<string, unknown> }> | undefined) ?? [];
    const edges = (d['edges'] as Array<{ from: string; to: string; when?: string }> | undefined) ?? [];
    const errors: Array<{ severity: string; nodeId?: string; message: string }> = nodes.some((n) => n.kind === 'trigger')
      ? []
      : [{ severity: 'error', message: 'A workflow needs at least one trigger.' }];
    const blockers: Array<{ severity: string; nodeId?: string; message: string }> = [];
    for (const n of nodes) {
      if (n.kind === 'branch') {
        const sides = edges
          .filter((e) => e.from === n.id)
          .map((e) => e.when)
          .sort()
          .join(',');
        if (sides !== 'gte,lt')
          errors.push({
            severity: 'error',
            nodeId: n.id,
            message: 'A branch needs exactly two outgoing connections: one "gte" (at or above the threshold) and one "lt" (below it).',
          });
      }
      if (n.kind !== 'trigger' && !edges.some((e) => e.to === n.id))
        errors.push({ severity: 'error', nodeId: n.id, message: 'This step is not connected to anything upstream.' });
      const bad = this.nodeKinds.find((k) => k.kind === n.kind && !k.supported);
      if (bad !== undefined) blockers.push({ severity: 'blocker', nodeId: n.id, message: String(bad.reason) });
      if (n.kind === 'trigger' && n.config?.['type'] !== 'manual')
        blockers.push({
          severity: 'blocker',
          nodeId: n.id,
          message: `There is no ${String(n.config?.['type'])} trigger support; only manual triggers run.`,
        });
      if (n.kind === 'capability' && typeof n.config?.['compilationId'] !== 'string')
        blockers.push({
          severity: 'blocker',
          nodeId: n.id,
          message: 'This capability step does not say which compilation it comes from, so the platform cannot bind it.',
        });
    }
    const wellFormed = errors.length === 0;
    if (!wellFormed || blockers.length > 0) return { wellFormed, runnable: false, errors, blockers };
    const by = new Map(nodes.map((n) => [n.id, n]));
    const steps: Array<Record<string, unknown>> = [];
    const branches: Array<Record<string, unknown>> = [];
    const path: string[] = [];
    let cur = nodes.find((n) => n.kind === 'trigger');
    let lastCap: (typeof nodes)[number] | undefined;
    for (let guard = 0; cur !== undefined && guard < 100; guard++) {
      path.push(cur.id);
      let next: { to: string } | undefined;
      if (cur.kind === 'capability') {
        const cid = String(cur.config?.['compilationId']);
        const capId = String(cur.config?.['capabilityId']);
        steps.push({
          nodeId: cur.id,
          capabilityId: capId,
          name: capId,
          executionClass: capId.includes('hitl') ? 'human_in_the_loop' : 'deterministic_rule',
          approved: this.approvedIds.has(`${cid}:${capId}`),
        });
        lastCap = cur;
        next = edges.find((e) => e.from === cur!.id);
      } else if (cur.kind === 'branch') {
        if (lastCap === undefined) {
          blockers.push({
            severity: 'blocker',
            nodeId: cur.id,
            message: "A branch must come directly after a capability; its confidence is that capability's declared confidence.",
          });
          break;
        }
        const threshold = Number(cur.config?.['threshold']);
        const taken = 0.8 >= threshold ? 'gte' : 'lt';
        branches.push({
          nodeId: cur.id,
          metric: 'confidence',
          basis: 'declared_contract_confidence',
          capabilityId: String(lastCap.config?.['capabilityId']),
          value: 0.8,
          threshold,
          taken,
        });
        next = edges.find((e) => e.from === cur!.id && e.when === taken);
      } else next = edges.find((e) => e.from === cur!.id);
      cur = next === undefined ? undefined : by.get(next.to);
    }
    if (blockers.length === 0 && steps.length === 0)
      blockers.push({ severity: 'blocker', message: 'The path a run takes has no capability step.' });
    if (blockers.length > 0) return { wellFormed, runnable: false, errors, blockers };
    const compilationId = String((nodes.find((n) => n.kind === 'capability')?.config ?? {})['compilationId']);
    return { wellFormed, runnable: true, errors, blockers, plan: { compilationId, path, steps, branches } };
  }
  private draftView(d: FakeDraft) {
    return {
      definitionId: d.definitionId,
      name: d.name,
      status: 'draft',
      revision: d.revision,
      nodes: d.nodes,
      edges: d.edges,
      analysis: this.analysis(d as unknown as Record<string, unknown>),
    };
  }
}
