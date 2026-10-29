// @vitest-environment node
/**
 * CONTRACT TEST: the Studio's client and wire parsers against the REAL @xo/api, booted in-process (same code, same
 * routes, real compiler for the fixture policy). If the API changes a field Studio relies on, or Studio's parser
 * drifts from what the server sends, this fails — which a hand-written fake can never tell you. No network beyond
 * 127.0.0.1; model provider and link fetcher are the API's own test seams, so nothing external is contacted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFsBlobStore } from '@xo/storage';
import { ScriptableTestProvider } from '@xo/ai-core';
import { packBundle } from '@xo/package-sdk';
import { createHttpServer } from '../../../api/src/server';
import { FsApiKeyStore } from '../../../api/src/auth/fs-api-key-store';
import { generateApiKey, hashApiKey } from '../../../api/src/auth/api-key';
import { buildFixtureBundle } from '../../../api/test/fixtures';
import { XoClient, type Result } from '../../src/platform/client';

const PDF = fileURLToPath(new URL('../../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const HITL = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522';
const DETERMINISTIC = 'cap_4d97baf947ce09949680b2165c99f71d';
/** What the fixture rule declares as required input. */
const RULE_INPUT = { claim: 'fire damage to the warehouse', lossadjuster_assessment: 'covered' };

let dir: string;
let server: http.Server;
let base: string;
let owner: XoClient;
let viewer: XoClient;
let ownerKey: string;
let ws: string;

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.problem.kind}: ${r.problem.message}`);
  return r.value;
};
const denied = <T>(r: Result<T>) => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.problem.kind).toBe('forbidden');
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xo-studio-contract-'));
  const keys = new FsApiKeyStore(new LocalFsBlobStore(join(dir, 'k')));
  const issue = async (identityId: string) => {
    const key = generateApiKey();
    await keys.create({ keyHash: hashApiKey(key), identityId, principalKind: 'service', createdAt: new Date().toISOString() });
    return key;
  };
  ownerKey = await issue('owner');
  const viewerKey = await issue('viewer-1');
  const provider = new ScriptableTestProvider('anthropic', [
    {
      kind: 'success',
      response: { text: 'Here is an answer.', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' },
    },
  ]);
  server = createHttpServer({
    apiKeyStore: keys,
    workspacesDir: join(dir, 'w'),
    workspaceDataDir: join(dir, 'd'),
    chatProviderFactory: (id) => (id === 'anthropic' ? provider : undefined),
    importFetch: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: new TextEncoder().encode('imported policy text with several words'),
      }),
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  owner = new XoClient({ apiKey: ownerKey, baseUrl: base });
  viewer = new XoClient({ apiKey: viewerKey, baseUrl: base });
  ws = must(await owner.createWorkspace('Aastha', { kind: 'team', region: 'in-mumbai' })).workspaceId;
  must(await owner.addMember(ws, { identityId: 'viewer-1', role: 'viewer', displayName: 'Rahul' }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('workspaces, members and roles', () => {
  it('workspace metadata and the caller role parse; a member sees the workspace with their own role', async () => {
    const mine = must(await owner.listWorkspaces()).find((w) => w.workspaceId === ws);
    expect(mine).toMatchObject({ kind: 'team', region: 'in-mumbai', regionLabel: 'India (Mumbai)', memberCount: 2, role: 'admin' });
    expect(must(await viewer.listWorkspaces()).find((w) => w.workspaceId === ws)?.role).toBe('viewer');
    expect(must(await owner.listRegions()).some((r) => r.id === 'in-mumbai')).toBe(true);
  });

  it('member list, role change and removal; a viewer cannot manage', async () => {
    const list = must(await owner.listMembers(ws));
    expect(list.callerRole).toBe('admin');
    expect(list.callerPermissions).toContain('manage');
    expect(list.members.find((m) => m.isOwner)?.identityId).toBe('owner');
    must(await owner.addMember(ws, { identityId: 'temp-member', role: 'reviewer' }));
    expect(must(await owner.changeMemberRole(ws, 'temp-member', 'publisher')).role).toBe('publisher');
    expect(must(await owner.removeMember(ws, 'temp-member')).removed).toBe('temp-member');
    denied(await viewer.addMember(ws, { identityId: 'x', role: 'admin' }));
    const asViewer = must(await viewer.listMembers(ws));
    expect(asViewer.callerRole).toBe('viewer');
    expect(asViewer.callerPermissions).toEqual(['read']);
  });
});

describe('audit log', () => {
  it('lists, verifies, exports exact bytes; a viewer is refused; retention is null unless declared', async () => {
    const page = must(await owner.listAudit(ws, { limit: 5 }));
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events[0]!.seq).toBeGreaterThan(page.events[page.events.length - 1]!.seq);
    const verified = must(await owner.verifyAudit(ws));
    expect(verified).toMatchObject({ ok: true, deletionSupported: false, retentionMinimumDays: null });
    const json = must(await owner.exportAudit(ws, 'json'));
    expect(JSON.parse(json).format).toBe('xo-audit-evidence/1');
    expect(must(await owner.exportAudit(ws, 'csv')).startsWith('seq,at,actor')).toBe(true);
    denied(await viewer.listAudit(ws));
    denied(await viewer.exportAudit(ws, 'json'));
    const denials = must(await owner.listAudit(ws, { event: 'access.denied' }));
    expect(denials.events.every((e) => e.result === 'denied')).toBe(true);
  });
});

describe('settings, runtime status and notifications', () => {
  it('settings round-trip with revision; the server states what is only declared', async () => {
    const before = must(await owner.getSettings(ws));
    expect(before.effect.residencyEnforced).toBe(false);
    expect(before.effect.signedPackagesNote).toMatch(/presence check only/);
    const updated = must(
      await owner.updateSettings(ws, {
        expectedRevision: before.settings.revision,
        model: { primary: { provider: 'anthropic', model: 'm' } },
        notifications: { onWorkflowComplete: true },
      }),
    );
    expect(updated.settings.revision).toBe(before.settings.revision + 1);
    expect(updated.settings.primary).toEqual({ provider: 'anthropic', model: 'm' });
    const stale = await owner.updateSettings(ws, { expectedRevision: before.settings.revision, airGapped: true });
    expect(stale.ok).toBe(false);
    denied(await viewer.updateSettings(ws, { airGapped: true }));
    expect(must(await viewer.getSettings(ws)).settings.revision).toBe(updated.settings.revision);
  });

  it('runtime status and notifications parse', async () => {
    const rt = must(await owner.getRuntimeStatus(ws));
    expect(rt.status).toBe('online');
    expect(rt.location).toBe('this_computer');
    const feed = must(await owner.listNotifications(ws));
    expect(typeof feed.unread).toBe('number');
    const top = feed.notifications[0];
    if (top !== undefined) expect(must(await owner.markNotificationsRead(ws, top.seq)).readThroughSeq).toBe(top.seq);
  });
});

describe('sources, compile, inbox, preview and test run', () => {
  let compilationId: string;

  it('uploads a real document, imports a link, and compiles', async () => {
    const bytes = await readFile(PDF);
    const file = new File([bytes], 'policy.pdf', { type: 'application/pdf' });
    const src = must(await owner.uploadSource(ws, file));
    compilationId = must(await owner.compileSource(ws, src.sourceId)).compilationId;
    const imported = must(await owner.importSourceFromUrl(ws, 'https://docs.example.com/terms.txt?token=SECRET'));
    expect(imported.originalFilename).toBe('terms.txt');
    denied(await viewer.importSourceFromUrl(ws, 'https://docs.example.com/terms.txt'));
  });

  it('Preview reports without executing, and the real run stays behind approval', async () => {
    const p = must(await owner.previewCapability(ws, compilationId, DETERMINISTIC, {}));
    expect(p).toMatchObject({
      approved: false,
      testRunAllowed: false,
      resolved: true,
      bindingClass: 'deterministic_rule',
      externalEffects: 'none',
    });
    expect(p.blockers.join(' ')).toMatch(/not approved/);
    expect(must(await owner.listExecutions(ws)).length).toBe(0);
    const run = await owner.createExecution(ws, compilationId, DETERMINISTIC, {});
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.problem.kind).toBe('forbidden');
    denied(await viewer.approveCapability(ws, compilationId, DETERMINISTIC));
  });

  it('a pending human task shows in the inbox, takes an info-request thread, and moves to Done on a decision', async () => {
    must(await owner.approveCapability(ws, compilationId, HITL));
    const exec = must(await owner.createExecution(ws, compilationId, HITL, {}));
    const inbox = must(await owner.listInbox(ws, 'needs_review'));
    expect(inbox.counts.needsReview).toBe(1);
    const item = inbox.items[0]!;
    expect(item).toMatchObject({ executionId: exec.executionId, state: 'needs_review', sourceFilename: 'policy.pdf' });
    const detail = must(await owner.getInboxItem(ws, item.executionId));
    expect(detail.infoRequests).toEqual([]);
    const asked = must(await owner.requestMoreInfo(ws, item.executionId, 'Was there forced entry?'));
    expect(asked.answer).toBeUndefined();
    expect(must(await owner.answerInfoRequest(ws, item.executionId, asked.requestId, 'Photos attached')).answer).toBe('Photos attached');
    expect(must(await owner.getInboxItem(ws, item.executionId)).infoRequests[0]?.answer).toBe('Photos attached');
    denied(await viewer.requestMoreInfo(ws, item.executionId, 'viewers cannot ask'));
    must(await owner.resolveHumanTask(ws, item.executionId, 'approve'));
    const done = must(await owner.listInbox(ws, 'done'));
    expect(done.items[0]).toMatchObject({ state: 'done', decision: 'approve' });
    const after = await owner.requestMoreInfo(ws, item.executionId, 'too late');
    expect(after.ok).toBe(false);
  });

  it('reports which node kinds the platform can run, to anyone who can read', async () => {
    const kinds = must(await viewer.getNodeKinds(ws));
    expect(kinds.filter((k) => k.supported).map((k) => k.kind)).toEqual(['trigger', 'capability', 'branch', 'human_review']);
    const schedule = kinds.find((k) => k.kind === 'trigger')?.variants.find((v) => v.value === 'schedule');
    expect(schedule).toMatchObject({ supported: false });
    expect(schedule?.reason).toMatch(/no scheduler/);
  });

  describe('running a saved draft and saved test cases (real runner, real approval gate)', () => {
    const detDraft = () => ({
      name: 'one rule',
      nodes: [
        { id: 'start', kind: 'trigger' as const, config: { type: 'manual' } },
        {
          id: 'rule',
          kind: 'capability' as const,
          config: { packageName: 'policy', capabilityId: DETERMINISTIC, memoryScope: 'none', compilationId },
        },
      ],
      edges: [{ from: 'start', to: 'rule' }],
    });

    it('the platform says runnable with a plan, refuses unapproved, then runs and records a real workflow run', async () => {
      const created = must(await owner.createDraft(ws, detDraft()));
      expect(created.analysis.runnable).toBe(true);
      expect(created.analysis.plan).toMatchObject({ compilationId, path: ['start', 'rule'] });
      expect(created.analysis.plan?.steps[0]).toMatchObject({
        capabilityId: DETERMINISTIC,
        executionClass: 'deterministic_rule',
        approved: false,
      });
      const before = must(await owner.listWorkflowRuns(ws)).length;

      denied(await viewer.runDraft(ws, created.definitionId, {}));
      denied(await owner.runDraft(ws, created.definitionId, { expectedRevision: created.revision })); // not approved yet: same gate as any run
      expect(must(await owner.listWorkflowRuns(ws)).length).toBe(before);

      must(await owner.approveCapability(ws, compilationId, DETERMINISTIC));
      expect(must(await owner.getDraft(ws, created.definitionId)).analysis.plan?.steps[0]?.approved).toBe(true);
      const stale = await owner.runDraft(ws, created.definitionId, { expectedRevision: created.revision + 1 });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.problem.status).toBe(409);

      const run = must(await owner.runDraft(ws, created.definitionId, { input: RULE_INPUT, expectedRevision: created.revision }));
      expect(run.workflowId).toBe(`draft:${created.definitionId}`);
      expect(run.draft).toMatchObject({ definitionId: created.definitionId, revision: created.revision, path: ['start', 'rule'] });
      expect(run.steps.map((st) => st.capabilityId)).toEqual([DETERMINISTIC]);
      expect(must(await owner.getWorkflowRun(ws, run.workflowExecutionId)).workflowExecutionId).toBe(run.workflowExecutionId);
      expect(must(await owner.listWorkflowRuns(ws)).length).toBe(before + 1);
    });

    it("a draft that is not runnable is refused with the platform's 501 and starts nothing", async () => {
      const before = must(await owner.listWorkflowRuns(ws)).length;
      const sched = {
        ...detDraft(),
        nodes: [{ id: 'start', kind: 'trigger' as const, config: { type: 'schedule' } }, detDraft().nodes[1]!],
      };
      const created = must(await owner.createDraft(ws, sched));
      expect(created.analysis.runnable).toBe(false);
      expect(created.analysis.blockers.map((b) => b.message).join(' ')).toMatch(/no scheduler/);
      const r = await owner.runDraft(ws, created.definitionId, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.kind).toBe('unavailable');
      expect(must(await owner.listWorkflowRuns(ws)).length).toBe(before);
    });

    it('saved test cases: author edits, reviewer/author run, the platform decides pass/fail, history is kept', async () => {
      must(await owner.approveCapability(ws, compilationId, DETERMINISTIC));
      const pass = must(
        await owner.createTestCase(ws, compilationId, DETERMINISTIC, {
          name: 'baseline',
          input: RULE_INPUT,
          expected: { status: 'succeeded' },
        }),
      );
      const fail = must(
        await owner.createTestCase(ws, compilationId, DETERMINISTIC, {
          name: 'wrong expectation',
          input: RULE_INPUT,
          expected: { status: 'failed' },
        }),
      );
      denied(await viewer.createTestCase(ws, compilationId, DETERMINISTIC, { name: 'x', input: {}, expected: { status: 'succeeded' } }));
      denied(await viewer.runTestCase(ws, compilationId, DETERMINISTIC, pass.caseId));
      expect(must(await viewer.listTestCases(ws, compilationId, DETERMINISTIC)).map((c) => c.name)).toEqual([
        'baseline',
        'wrong expectation',
      ]);

      const ran = must(await owner.runTestCase(ws, compilationId, DETERMINISTIC, pass.caseId));
      expect(ran).toMatchObject({ pass: true, caseRevision: 1, actual: { status: 'succeeded' } });
      expect(must(await owner.listExecutions(ws)).some((e) => e.executionId === ran.executionId)).toBe(true);

      const batch = must(await owner.runTestCases(ws, compilationId, DETERMINISTIC));
      expect([batch.passed, batch.failed]).toEqual([1, 1]);
      expect(batch.runs.find((r) => r.caseId === fail.caseId)?.mismatches.join(' ')).toMatch(/status: expected "failed"/);
      expect(must(await owner.testCaseHistory(ws, compilationId, DETERMINISTIC, pass.caseId))).toHaveLength(2);
      expect(must(await owner.listTestCases(ws, compilationId, DETERMINISTIC)).find((c) => c.caseId === pass.caseId)?.lastRun?.pass).toBe(
        true,
      );

      const edited = must(
        await owner.updateTestCase(ws, compilationId, DETERMINISTIC, fail.caseId, {
          name: 'now right',
          input: RULE_INPUT,
          expected: { status: 'succeeded' },
          expectedRevision: 1,
        }),
      );
      expect(edited.revision).toBe(2);
      const stale = await owner.updateTestCase(ws, compilationId, DETERMINISTIC, fail.caseId, {
        name: 'stale',
        input: RULE_INPUT,
        expected: { status: 'succeeded' },
        expectedRevision: 1,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.problem.reason).toBe('stale_revision');
      expect(must(await owner.deleteTestCase(ws, compilationId, DETERMINISTIC, fail.caseId)).deleted).toBe(true);
    });
  });
});

describe('library and installs', () => {
  it('lists a published package with honest trust flags, installs and uninstalls it', async () => {
    const archive = Buffer.from(await packBundle(buildFixtureBundle({ name: 'burglary_policy' })));
    const pub = await fetch(`${base}/workspaces/${ws}/registry/packages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerKey}` },
      body: archive,
    });
    expect(pub.status).toBe(201);
    const id = ((await pub.json()) as { id: string }).id;

    const lib = must(await owner.listLibrary(ws));
    const item = lib.items.find((i) => i.id === id)!;
    expect(item).toMatchObject({ name: 'burglary_policy', installed: false, madeByMe: true });
    expect(item.trust).toMatchObject({ signed: false, signaturesVerified: false, independentlyVerified: false });
    expect(must(await owner.listLibrary(ws, { q: 'burglary' })).items).toHaveLength(1);
    expect(must(await viewer.listLibrary(ws)).items.find((i) => i.id === id)?.madeByMe).toBe(false);

    expect(must(await owner.getLibraryPackage(ws, id)).installable).toBe(true);
    denied(await viewer.installPackage(ws, id));
    expect(must(await owner.installPackage(ws, id)).name).toBe('burglary_policy');
    expect(must(await owner.listLibrary(ws, { scope: 'installed' })).items).toHaveLength(1);
    expect(must(await owner.listInstalls(ws))).toHaveLength(1);
    expect(must(await owner.uninstallPackage(ws, 'burglary_policy', '1.0.0')).uninstalled).toContain('burglary_policy');
  });
});

describe('chat', () => {
  it('persists a private thread and answers from the selected model; a colleague cannot read it', async () => {
    const thread = must(await owner.createChat(ws));
    const reply = must(await owner.sendChatMessage(ws, thread.threadId, 'What does clause 4.2 say?'));
    expect(reply.assistantMessage.content).toBe('Here is an answer.');
    expect(reply.title).toBe('What does clause 4.2 say?');
    const full = must(await owner.getChat(ws, thread.threadId));
    expect(full.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(must(await owner.listChats(ws)).map((t) => t.threadId)).toContain(thread.threadId);
    const other = await viewer.getChat(ws, thread.threadId);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.problem.kind).toBe('not_found');
    expect(must(await owner.deleteChat(ws, thread.threadId)).deleted).toBe(thread.threadId);
  });
});

describe('workflow drafts', () => {
  const draft = {
    name: 'claims-triage',
    nodes: [
      { id: 'claim_pdf', kind: 'trigger' as const, config: { type: 'document_dropped' } },
      { id: 'compile', kind: 'compile' as const, config: {} },
      { id: 'confidence', kind: 'branch' as const, config: { metric: 'confidence', threshold: 0.9 } },
      { id: 'human', kind: 'human_review' as const, config: {} },
      { id: 'end', kind: 'validate' as const, config: {} },
    ],
    edges: [
      { from: 'claim_pdf', to: 'compile' },
      { from: 'compile', to: 'confidence' },
      { from: 'confidence', to: 'end', when: 'gte' as const },
      { from: 'confidence', to: 'human', when: 'lt' as const },
    ],
  };

  it('saves with revision guard and reports concretely why this draft cannot run', async () => {
    const analysis = must(await owner.validateDraft(ws, draft));
    expect(analysis.wellFormed).toBe(true);
    expect(analysis.runnable).toBe(false);
    expect(analysis.blockers.map((b) => b.message).join(' ')).toMatch(/no folder or drop watcher/);
    const created = must(await owner.createDraft(ws, draft));
    expect(created.revision).toBe(1);
    const v2 = must(await owner.saveDraft(ws, created.definitionId, { ...draft, name: 'renamed', expectedRevision: 1 }));
    expect(v2.revision).toBe(2);
    const stale = await owner.saveDraft(ws, created.definitionId, { ...draft, name: 'stale', expectedRevision: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.problem.reason).toBe('stale_revision');
    expect(must(await owner.getDraft(ws, created.definitionId)).name).toBe('renamed');
    expect(must(await owner.listDrafts(ws))[0]).toMatchObject({ definitionId: created.definitionId, revision: 2 });
    denied(await viewer.saveDraft(ws, created.definitionId, { ...draft, expectedRevision: 2 }));
    expect(must(await owner.deleteDraft(ws, created.definitionId)).deleted).toBe(created.definitionId);
  });
});
