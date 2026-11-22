import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { NonProductionAuditSink } from '@xo/audit';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { TestServer, withTempDir } from './test-helpers.js';

/**
 * UW-8 (ADR 0046, UAC-7): batch preview and batch-bound approval. A person approves the exact set of calls a batch will make; any
 * change to a recipient, attachment, message or sender after that invalidates the approval; it is single-use; the approver is
 * someone other than whoever prepared it; and immediately before each call the actual arguments must equal what was approved.
 */

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Mail', version: '1' },
  paths: {
    '/send': {
      post: {
        operationId: 'sendCertificate',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { to: { type: 'string' }, subject: { type: 'string' }, attachment: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  },
});
const binding = (extra: Record<string, unknown> = {}) => ({
  capability: 'sendCertificate',
  connector: 'mail',
  kind: 'http',
  operation: 'send_certificate',
  sideEffect: 'irreversible',
  adapter: 'mail-adapter',
  ...extra,
});

function mailer() {
  const sent: { dispatchKey: string; to: string; attachment: string }[] = [];
  const adapter = {
    id: 'mail-adapter',
    approvalMode: 'capability',
    invoke: async (r: { dispatchKey: string; input: { to?: string; attachment?: string } }) => {
      sent.push({ dispatchKey: r.dispatchKey, to: String(r.input.to), attachment: String(r.input.attachment) });
      return { kind: 'confirmed_success', output: { id: `m_${sent.length}` } } as ExternalToolResult;
    },
  } as unknown as ExternalToolAdapter;
  return { adapter, sent };
}

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ to: `person${i}@example.org`, subject: 'Your certificate', attachment: `sha256-${i}` }));

interface PreviewView {
  previewId: string;
  root: string;
  counts: Record<string, number>;
  effects: boolean;
  approvable: boolean;
  total: number;
  pages: number;
  items: { index: number; state: string; actions: { step: string; args: Record<string, unknown> }[] }[];
  approval?: { approvalId: string; reviewerId: string; usedBy?: string };
}

async function env(
  fn: (e: {
    server: TestServer;
    mail: ReturnType<typeof mailer>;
    ws: string;
    defId: string;
    certId: string;
    reviewer: Record<string, string>;
    audit: NonProductionAuditSink;
    dir: string;
  }) => Promise<void>,
) {
  await withTempDir('xo-api-batch-', async (dir) => {
    const mail = mailer();
    const audit = new NonProductionAuditSink();
    const server = await TestServer.start({
      auditSink: audit,
      workspaceDataDir: join(dir, 'd'),
      workspacesDir: join(dir, 'w'),
      ...NO_OCR,
      connectorAdapters: new Map([['mail-adapter', mail.adapter]]),
      runApproval: 'required',
      approvalSeparation: 'required',
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=mail.json`, Buffer.from(OPENAPI))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      assert.equal((await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [binding()] })).status, 200);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'send a certificate', forEach: 'person' },
        })
      ).json<{ definition: { definitionId: string } }>().definition;
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
      }>();
      assert.equal(cert.status, 'READY');
      await fn({ server, mail, ws, defId: def.definitionId, certId: cert.certificateId, reviewer, audit, dir });
    } finally {
      await server.stop();
    }
  });
}

test('UAC-7: a 300-item batch is previewed exactly, approved once by someone else, and sends exactly what was approved', async () => {
  await env(async ({ server, mail, ws, defId, certId, reviewer, audit }) => {
    const base = `/workspaces/${ws}/generated-workflows/${defId}`;
    const input = { person_items: people(300) };

    // In production a run that can send starts only with a batch approval.
    const unapproved = await server.request('POST', `${base}/runs`, { input, certificateId: certId });
    assert.equal(unapproved.status, 409, unapproved.bodyText);
    assert.match(unapproved.bodyText, /XO_BATCH_APPROVAL_REQUIRED/);

    const created = await server.request('POST', `${base}/previews`, { input, certificateId: certId });
    assert.equal(created.status, 201, created.bodyText);
    const p = created.json<PreviewView>();
    assert.equal(mail.sent.length, 0, 'a preview sends nothing');
    assert.deepEqual(p.counts, { sends: 300, no_effect: 0, stops: 0, not_exact: 0 });
    assert.equal(p.approvable, true);
    assert.equal(p.pages, 6);
    assert.deepEqual(p.items[0]!.actions[0]!.args, { to: 'person0@example.org', subject: 'Your certificate', attachment: 'sha256-0' });
    const page6 = (await server.request('GET', `${base}/previews/${p.previewId}?page=6`)).json<PreviewView>();
    assert.equal(page6.items.at(-1)!.index, 299);

    // UW-12b: the inbox shows the preview waiting for an approval; to the person who prepared it, that it was theirs.
    type Inbox = {
      batches: { previewId: string; state: string; preparedByYou: boolean; total: number; approval?: { approvalId: string } }[];
    };
    const inboxAs = async (h?: Record<string, string>) =>
      (await server.request('GET', `/workspaces/${ws}/control/inbox`, undefined, h)).json<Inbox>().batches;
    assert.deepEqual(
      (await inboxAs()).map((b) => [b.previewId, b.state, b.preparedByYou, b.total]),
      [[p.previewId, 'awaiting_approval', true, 300]],
    );
    assert.deepEqual(
      (await inboxAs(reviewer)).map((b) => [b.state, b.preparedByYou]),
      [['awaiting_approval', false]],
    );

    // The person who prepared it cannot approve it; a root other than the one shown is refused; the reviewer approves the root.
    const self = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root });
    assert.equal(self.status, 409, self.bodyText);
    assert.match(self.bodyText, /someone other than the person who prepared/);
    const wrong = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: 'sha256:00' }, reviewer);
    assert.equal(wrong.status, 409);
    const ok = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer);
    assert.equal(ok.status, 201, ok.bodyText);
    const approvalId = ok.json<PreviewView>().approval!.approvalId;
    assert.equal(ok.json<PreviewView>().approval!.reviewerId, 'reviewer-1');
    const twice = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer);
    assert.equal(twice.status, 409, 'one approval per preview');

    assert.deepEqual(
      (await inboxAs()).map((b) => [b.state, b.approval?.approvalId]),
      [['ready_to_start', approvalId]],
    );

    // Start with the approval (the approved input is used); every item sends once, exactly as previewed.
    const started = await server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: approvalId });
    assert.equal(started.status, 201, started.bodyText);
    assert.equal(started.json<{ state: string }>().state, 'completed');
    assert.equal(mail.sent.length, 300);
    assert.deepEqual(new Set(mail.sent.map((m) => m.to)).size, 300);
    const runId = started.json<{ runId: string }>().runId;

    // Single use: a second start with it is the same run (a retry), never a second batch.
    const again = await server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: approvalId });
    assert.equal(again.status, 200, again.bodyText);
    assert.equal(again.json<{ runId: string }>().runId, runId);
    assert.equal(mail.sent.length, 300, 'nothing was sent twice');
    const shown = (await server.request('GET', `${base}/previews/${p.previewId}`)).json<PreviewView>();
    assert.equal(shown.approval?.usedBy, runId);
    assert.deepEqual(await inboxAs(), [], 'a used approval leaves the inbox');

    // Audit holds ids and counts, never a recipient.
    const events = audit.events().filter((e) => e.type.startsWith('generated-workflow.batch.'));
    assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), [
      'generated-workflow.batch.approved',
      'generated-workflow.batch.previewed',
      'generated-workflow.batch.refused',
      'generated-workflow.batch.required',
    ]);
    assert.ok(!JSON.stringify(audit.events()).includes('@example.org'), 'no recipient in the audit trail');
  });
});

test('UAC-7: a change after approval (a recipient in the input, the sending binding) refuses the start; nothing is sent', async () => {
  await env(async ({ server, mail, ws, defId, certId, reviewer }) => {
    const base = `/workspaces/${ws}/generated-workflows/${defId}`;
    const approve = async (input: Record<string, unknown>) => {
      const p = (await server.request('POST', `${base}/previews`, { input, certificateId: certId })).json<PreviewView>();
      const r = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer);
      assert.equal(r.status, 201, r.bodyText);
      return r.json<PreviewView>().approval!.approvalId;
    };

    // One recipient changed in the input: refused.
    const a1 = await approve({ person_items: people(3) });
    const changed = people(3);
    changed[1] = { ...changed[1]!, to: 'someone.else@example.org' };
    const r1 = await server.request('POST', `${base}/runs`, {
      input: { person_items: changed },
      certificateId: certId,
      batchApprovalId: a1,
    });
    assert.equal(r1.status, 409, r1.bodyText);
    assert.match(r1.bodyText, /input differs/);

    // The sending binding changed after approval (another adapter would send): the certificate the approval is bound to is stale,
    // so the start is refused before the batch check even runs. An approval never outlives its certificate.
    const a2 = await approve({ person_items: people(2) });
    assert.equal(
      (await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [binding({ adapter: 'other-mail' })] })).status,
      200,
    );
    const r2 = await server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: a2 });
    assert.equal(r2.status, 409, r2.bodyText);
    assert.match(r2.bodyText, /connector bindings changed/);
    assert.equal(mail.sent.length, 0, 'nothing was sent');
  });
});

test('the root changes with any recipient, attachment, message or sending account, and with nothing else', async () => {
  const { actionDigest, digestOfJson, rootOf } = await import('../src/approvals/batch-approval.js');
  const leaf = (args: Record<string, unknown>, binding = 'sha256:b') =>
    digestOfJson({
      index: 0,
      state: 'sends',
      approvals: [],
      actions: [
        actionDigest({
          step: 'send',
          connector: 'mail',
          operation: 'send',
          sideEffect: 'irreversible',
          binding,
          argsDigest: digestOfJson(args),
        }),
      ],
    });
  const root = (l: string) => rootOf({ definitionId: 'd', certificateId: 'c', inputDigest: 'i', leaves: [l] });
  const args = { to: 'a@example.org', subject: 'Hello', body: 'Text', attachments: [{ filename: 'c.pdf', sha256: 'aa' }] };
  const base = root(leaf(args));
  assert.equal(root(leaf({ ...args })), base, 'the same calls give the same root');
  assert.equal(
    root(leaf({ subject: 'Hello', to: 'a@example.org', attachments: args.attachments, body: 'Text' })),
    base,
    'key order does not matter',
  );
  for (const changed of [
    { ...args, to: 'b@example.org' },
    { ...args, subject: 'Hello!' },
    { ...args, body: 'Text.' },
    { ...args, attachments: [{ filename: 'c.pdf', sha256: 'ab' }] },
  ])
    assert.notEqual(root(leaf(changed)), base);
  assert.notEqual(root(leaf(args, 'sha256:other-account')), base, 'another sending account');
});

test('UAC-7: immediately before each call, the actual arguments must equal what was approved', async () => {
  await env(async ({ server, mail, ws, defId, certId, reviewer, dir }) => {
    const base = `/workspaces/${ws}/generated-workflows/${defId}`;
    const p = (
      await server.request('POST', `${base}/previews`, { input: { person_items: people(2) }, certificateId: certId })
    ).json<PreviewView>();
    const approvalId = (
      await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer)
    ).json<PreviewView>().approval!.approvalId;
    // Tamper with the stored preview after approval (as if what was approved differed from what runs): the item's call digest no
    // longer matches the call, so the call is refused and nothing is sent. The start-time check passes because the root is unchanged.
    const runsRoot = join(dir, 'd');
    const previewFile = await findFile(runsRoot, `${p.previewId}.json`);
    const record = JSON.parse(await (await import('node:fs/promises')).readFile(previewFile, 'utf8')) as {
      items: { actions: { digest: string }[] }[];
    };
    record.items[1]!.actions[0]!.digest = 'sha256:tampered';
    await writeFile(previewFile, JSON.stringify(record));
    const started = await server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: approvalId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    assert.deepEqual(
      mail.sent.map((m) => m.to),
      ['person0@example.org'],
      'only the item whose call matched what was approved was sent',
    );
  });
});

async function findFile(root: string, name: string): Promise<string> {
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  await mkdir(root, { recursive: true });
  throw new Error(`${name} not found under ${root}`);
}

const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

test('a run started with a batch approval has each approval step the preview showed decided by it, as the approver, verifiably', async () => {
  await withTempDir('xo-api-batch-proc-', async (dir) => {
    const server = await TestServer.start({
      workspaceDataDir: join(dir, 'd'),
      workspacesDir: join(dir, 'w'),
      ...NO_OCR,
      approvalSeparation: 'required',
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'Ship a release', needs: ['Run the full test suite'] },
        })
      ).json<{ definition: { definitionId: string } }>().definition;
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
      }>();
      const base = `/workspaces/${ws}/generated-workflows/${def.definitionId}`;

      const pr = await server.request('POST', `${base}/previews`, { input: {}, certificateId: cert.certificateId });
      assert.equal(pr.status, 201, pr.bodyText);
      const p = pr.json<PreviewView & { items: { approvals: string[] }[] }>();
      assert.equal(p.items.length, 1, 'a run that is not a list is a batch of one');
      assert.ok(p.items[0]!.approvals.length >= 1, 'the preview names the approval steps the run reaches');
      const approvalId = (
        await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer)
      ).json<PreviewView>().approval!.approvalId;

      const run = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, batchApprovalId: approvalId });
      assert.equal(run.status, 201, run.bodyText);
      const view = run.json<{
        state: string;
        pendingApprovals: unknown[];
        decisions: { reviewerId: string; signatureVerified: boolean }[];
      }>();
      assert.equal(view.state, 'completed');
      assert.deepEqual(view.pendingApprovals, []);
      assert.equal(view.decisions.length, p.items[0]!.approvals.length);
      for (const d of view.decisions) {
        assert.equal(d.reviewerId, 'reviewer-1', 'decided as the person who approved the batch');
        assert.equal(d.signatureVerified, true);
      }
    } finally {
      await server.stop();
    }
  });
});

test('UAC-7: two starts with the same approval at the same moment make one run; each item is sent once', async () => {
  await env(async ({ server, mail, ws, defId, certId, reviewer }) => {
    const base = `/workspaces/${ws}/generated-workflows/${defId}`;
    const p = (
      await server.request('POST', `${base}/previews`, { input: { person_items: people(20) }, certificateId: certId })
    ).json<PreviewView>();
    const approvalId = (
      await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer)
    ).json<PreviewView>().approval!.approvalId;
    const [a, b] = await Promise.all([
      server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: approvalId }),
      server.request('POST', `${base}/runs`, { certificateId: certId, batchApprovalId: approvalId }),
    ]);
    assert.ok(
      [a.status, b.status].every((s) => s === 200 || s === 201),
      `${a.bodyText} ${b.bodyText}`,
    );
    assert.equal(a.json<{ runId: string }>().runId, b.json<{ runId: string }>().runId, 'one run');
    // Whichever request drove it, every item was sent exactly once.
    const final = (await server.request('GET', `${base}/runs/${a.json<{ runId: string }>().runId}`)).json<{ state: string }>();
    assert.equal(final.state, 'completed');
    assert.equal(mail.sent.length, 20);
    assert.equal(new Set(mail.sent.map((m) => m.dispatchKey)).size, 20);
  });
});
