/**
 * V1 acceptance (docs/runtime/V1_ACCEPTANCE.md): the certificate-distribution vertical through the integrated API, as far as it runs
 * today, on one instance with production approval rules and strict-local residency. A LOCAL FAKE Gmail stands in for the provider.
 *
 * What it proves end to end: a client list and certificates uploaded as sources; a send operation bound to the email adapter; a goal
 * composed per client; a READY certificate; a batch preview that shows every recipient and attachment; approval by a reviewer who did
 * not prepare it; a start that sends exactly what was approved, once each, with the right certificate attached; a run manifest; a signed
 * audit bundle that verifies; a reproducible replay; nothing left waiting for a person; no model asked anything.
 *
 * Where today's path needs the caller (the gaps V1-G1 and V1-G2 in the acceptance report): the send step comes from a declared operation
 * (a plain-language "email the client their certificate" compiles to a person's task), and the per-client items are assembled by the
 * caller from the client list, not by XO from the confirmed list and the matched certificates. Those two lines are marked below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { NonProductionAuditSink } from '@xo/audit';
import { Secret } from '@xo/connectors';
import type { AdapterCredential, AdapterCredentialHandle } from '@xo/adapters';
import { resolveResidency } from '@xo/ai-core';
import type { CredentialsConfig } from '../src/credentials/credentials.js';
import { TestServer, withTempDir } from './test-helpers.js';
import { createMailAdapter } from '../src/email/mail-adapter.js';
import { workspaceAttachmentStore } from '../src/email/attachments.js';
import { readRecipientRules } from '../src/email/recipient-rules.js';
import { fakeGmail, newMailbox } from '../../../packages/connectors/test/mail-fakes.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };

const CLIENTS = [
  { name: 'Asha Rao', email: 'asha@client.example' },
  { name: 'Bilal Khan', email: 'bilal@client.example' },
  { name: 'Chen Wei', email: 'chen@client.example' },
];
const csv = `Name,Email,Certificate\n${CLIENTS.map((c) => `${c.name},${c.email},${c.name.toLowerCase().replace(' ', '-')}.pdf`).join('\n')}\n`;
const certificate = (name: string) => Buffer.from(`%PDF-1.4\n% Certificate of completion for ${name}\n%%EOF\n`);

// V1-G1: the send is a declared operation (the flat form of the email contract), not composed from the procedure's own words.
const SEND_OPERATION = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Certificates', version: '1' },
  paths: {
    '/send': {
      post: {
        operationId: 'sendCertificate',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  to: { type: 'string' },
                  subject: { type: 'string' },
                  body: { type: 'string' },
                  attachmentSha256: { type: 'string' },
                  attachmentFilename: { type: 'string' },
                  attachmentContentType: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { sent: { type: 'boolean' } } } } },
          },
        },
      },
    },
  },
});

interface Preview {
  previewId: string;
  root: string;
  counts: Record<string, number>;
  total: number;
  items: { index: number; state: string; actions: { args: Record<string, unknown> }[] }[];
  approval?: { approvalId: string };
}

test('V1: the certificate flow runs end to end through the API with production approval rules, sending exactly what was approved', async () => {
  await withTempDir('xo-api-v1-', async (dataDir) => {
    const box = newMailbox();
    const gm = await fakeGmail(box);
    const cfg = { dataRootDir: dataDir } as never;
    const credential: AdapterCredential = {
      use: async (fn) =>
        fn({
          record: {
            provider: 'google',
            kind: 'oauth',
            scopes: ['https://www.googleapis.com/auth/gmail.send'],
            accountLabel: 'office@firm.example',
          },
          accessToken: new Secret('fake-token-v1'),
        } as AdapterCredentialHandle),
    };
    const factory = (workspace: never) => {
      const inner = createMailAdapter({
        env: {},
        attachments: workspaceAttachmentStore(workspace, cfg),
        recipientPolicy: async () => {
          const r = await readRecipientRules(workspace, cfg);
          return { confirmed: new Set(), rules: { addresses: r.addresses, domains: r.domains } };
        },
        endpoints: { gmail: gm.baseUrl, egress: { allowPrivateNetwork: true, allowedPorts: [Number(new URL(gm.baseUrl).port)] } },
      });
      return { ...inner, invoke: (r: Parameters<typeof inner.invoke>[0]) => inner.invoke({ ...r, credential }) };
    };
    const audit = new NonProductionAuditSink();
    const server = await TestServer.start({
      workspaceDataDir: dataDir,
      ...NO_OCR,
      auditSink: audit,
      adapterFactories: new Map([['email', factory]]),
      residency: resolveResidency({ XO_RESIDENCY: 'strict_local' }),
      runApproval: 'required',
      approvalSeparation: 'required',
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);

      // 1. Sources: the client list (read into a record set at the door) and one certificate per client, found later by content hash.
      const list = await server.request('POST', `/workspaces/${ws}/sources?filename=clients.csv`, Buffer.from(csv));
      assert.equal(list.status, 201, list.bodyText);
      const hashes = new Map<string, string>();
      for (const c of CLIENTS) {
        const bytes = certificate(c.name);
        const file = `${c.name.toLowerCase().replace(' ', '-')}.pdf`;
        const up = await server.request('POST', `/workspaces/${ws}/sources?filename=${file}`, bytes);
        assert.equal(up.status, 201, up.bodyText);
        hashes.set(c.email, createHash('sha256').update(bytes).digest('hex'));
      }
      assert.equal((await server.request('PUT', `/workspaces/${ws}/email/recipient-rules`, { domains: ['client.example'] })).status, 200);

      // 2. The send, bound to the workspace's email adapter; approved; composed per client.
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=certificates.json`, Buffer.from(SEND_OPERATION))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const bound = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [
          { capability: 'sendCertificate', connector: 'email', kind: 'http', operation: 'send', sideEffect: 'write', adapter: 'email' },
        ],
      });
      assert.equal(bound.status, 200, bound.bodyText);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'send each client their certificate', forEach: 'client' },
        })
      ).json<{ definition: { definitionId: string; lowered: { complete: boolean; issues: unknown[] } } }>().definition;
      assert.equal(def.lowered.complete, true, JSON.stringify(def.lowered.issues));
      const base = `/workspaces/${ws}/generated-workflows/${def.definitionId}`;
      const cert = (await server.request('POST', `${base}/readiness`, {})).json<{ certificateId: string; status: string }>();
      assert.equal(cert.status, 'READY');

      // 3. V1-G2: the items are assembled here from the client list, not by XO from the confirmed list and the matched certificates.
      const items = CLIENTS.map((c) => ({
        to: c.email,
        subject: 'Your certificate',
        body: `Dear ${c.name}, your certificate is attached.`,
        attachmentSha256: hashes.get(c.email)!,
        attachmentFilename: `${c.name.toLowerCase().replace(' ', '-')}.pdf`,
        attachmentContentType: 'application/pdf',
      }));

      // 4. Production rules: no start without a batch approval; the preview shows every call; someone else approves it.
      const refused = await server.request('POST', `${base}/runs`, { input: { client_items: items }, certificateId: cert.certificateId });
      assert.equal(refused.status, 409);
      assert.match(refused.bodyText, /XO_BATCH_APPROVAL_REQUIRED/);
      const preview = await server.request('POST', `${base}/previews`, {
        input: { client_items: items },
        certificateId: cert.certificateId,
      });
      assert.equal(preview.status, 201, preview.bodyText);
      const p = preview.json<Preview>();
      assert.deepEqual(p.counts, { sends: 3, no_effect: 0, stops: 0, not_exact: 0 });
      assert.deepEqual(
        p.items.map((i) => [i.actions[0]!.args['to'], i.actions[0]!.args['attachmentSha256']]),
        CLIENTS.map((c) => [c.email, hashes.get(c.email)]),
      );
      assert.equal(box.messages.length, 0, 'a preview sends nothing');
      const inbox = (await server.request('GET', `/workspaces/${ws}/control/inbox`, undefined, reviewer)).json<{
        batches: { previewId: string; state: string }[];
      }>();
      assert.deepEqual(
        inbox.batches.map((b) => [b.previewId, b.state]),
        [[p.previewId, 'awaiting_approval']],
      );
      assert.equal(
        (await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root })).status,
        409,
        'not by its preparer',
      );
      const ok = await server.request('POST', `${base}/previews/${p.previewId}/approve`, { root: p.root }, reviewer);
      assert.equal(ok.status, 201, ok.bodyText);
      const approvalId = ok.json<Preview>().approval!.approvalId;

      // 5. The start sends exactly what was approved, once each, with each client's own certificate.
      const started = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, batchApprovalId: approvalId });
      assert.equal(started.status, 201, started.bodyText);
      const run = started.json<{ runId: string; state: string }>();
      assert.equal(run.state, 'completed', started.bodyText);
      assert.equal(box.messages.length, 3);
      for (const c of CLIENTS) {
        const sent = box.messages.filter((m) => m.data.includes(`To: ${c.email}`) || m.data.includes(`<${c.email}>`));
        assert.equal(sent.length, 1, `exactly one message to ${c.email}`);
        assert.ok(sent[0]!.data.includes(certificate(c.name).toString('base64').slice(0, 24)), `${c.email} got their own certificate`);
        assert.match(sent[0]!.data, /Message-ID: <xo\.[0-9a-f]{32}@firm\.example>/);
      }
      const again = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, batchApprovalId: approvalId });
      assert.equal(again.json<{ runId: string }>().runId, run.runId);
      assert.equal(box.messages.length, 3, 'a repeated start is the same run; nothing is sent twice');

      // 6. Evidence: manifest, a signed bundle that verifies, a reproducible replay, nothing waiting for a person.
      const manifest = (await server.request('GET', `${base}/runs/${run.runId}/manifest`)).json<{
        digestOk: boolean;
        manifest: { batch?: { approvalId: string }; certificate: { certificateId: string } };
      }>();
      assert.equal(manifest.digestOk, true);
      assert.equal(manifest.manifest.batch?.approvalId, approvalId);
      assert.equal(manifest.manifest.certificate.certificateId, cert.certificateId);
      const bundle = await server.request('GET', `${base}/runs/${run.runId}/audit-bundle`, undefined, reviewer);
      assert.equal(bundle.status, 200);
      const verified = (await server.request('POST', `/workspaces/${ws}/audit-bundles/verify`, bundle.json<unknown>())).json<{
        ok: boolean;
        runs: number;
      }>();
      assert.deepEqual([verified.ok, verified.runs], [true, 4]);
      const replay = (await server.request('GET', `${base}/runs/${run.runId}/replay`)).json<{ reproducible: boolean; reasons: string[] }>();
      assert.deepEqual([replay.reproducible, replay.reasons], [true, []]);
      const after = (await server.request('GET', `/workspaces/${ws}/control/inbox`)).json<{
        batches: unknown[];
        steps: unknown[];
        attention: unknown[];
      }>();
      assert.deepEqual([after.batches, after.steps, after.attention], [[], [], []]);

      // 7. Audit holds ids and counts, never a recipient or a certificate's content; no model was asked anything.
      const trail = JSON.stringify(audit.events());
      assert.ok(!trail.includes('@client.example'), 'no recipient in the audit trail');
      assert.ok(!trail.includes('Certificate of completion'));
      assert.equal(audit.events().filter((e) => e.type === 'model.egress.blocked' || e.type === 'intent.proposed').length, 0);
    } finally {
      await server.stop();
      await gm.close();
    }
  });
});

test('UAC-32: the batch preview says which tier an email binding sends in, in plain words', async () => {
  await withTempDir('xo-api-v1-tier-', async (dataDir) => {
    const credentials: CredentialsConfig = {
      masterKey: randomBytes(32),
      clients: { google: undefined, microsoft: undefined },
      redirectUri: 'https://xo.acme.example/oauth/callback',
    };
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR, credentials });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const basic = await server.request('POST', `/workspaces/${ws}/credentials/basic`, {
        provider: 'smtp',
        capabilities: ['message.send'],
        username: 'office@firm.example',
        host: 'smtp.firm.example',
        password: 'app-password',
      });
      assert.equal(basic.status, 201, basic.bodyText);
      const credentialId = basic.json<{ credential: { credentialId: string } }>().credential.credentialId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=certificates.json`, Buffer.from(SEND_OPERATION))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const bound = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [
          {
            capability: 'sendCertificate',
            connector: 'email',
            kind: 'http',
            operation: 'send',
            sideEffect: 'write',
            adapter: 'email',
            credentialId,
          },
        ],
      });
      assert.equal(bound.status, 200, bound.bodyText);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'send each client their certificate', forEach: 'client' },
        })
      ).json<{ definition: { definitionId: string } }>().definition;
      const base = `/workspaces/${ws}/generated-workflows/${def.definitionId}`;
      const cert = (await server.request('POST', `${base}/readiness`, {})).json<{ certificateId: string; status: string }>();
      assert.equal(cert.status, 'READY', JSON.stringify(cert));
      const item = {
        to: 'asha@client.example',
        subject: 's',
        body: 'b',
        attachmentSha256: 'a'.repeat(64),
        attachmentFilename: 'a.pdf',
        attachmentContentType: 'application/pdf',
      };
      const p = await server.request('POST', `${base}/previews`, { input: { client_items: [item] }, certificateId: cert.certificateId });
      assert.equal(p.status, 201, p.bodyText);
      const senders = p.json<{ senders: { connector: string; account?: string; tier?: string; tierExplanation?: string }[] }>().senders;
      assert.deepEqual(
        senders.map((s) => [s.connector, s.account, s.tier]),
        [['email', 'office@firm.example', 'send_only']],
      );
      assert.match(senders[0]!.tierExplanation ?? '', /waits for a person to confirm/);
    } finally {
      await server.stop();
    }
  });
});

test('V1-G1: a plain-language "email each client their certificate" becomes an act step once the workspace binds it with arguments', async () => {
  const PROCEDURE = `# Certificate distribution procedure\n\n## Procedure\n1. For each client, email the client their certificate.\n`;
  await withTempDir('xo-api-v1-g1-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=procedure.md`, Buffer.from(PROCEDURE))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const generate = async () =>
        (
          await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
            goal: { text: 'send each client their certificate', forEach: 'client' },
          })
        ).json<{ definition: { lowered: { component: { workflows: { steps: { id: string; type: string; inputs?: unknown }[] }[] } } } }>()
          .definition.lowered.component.workflows[0]!.steps;

      const emailStep = (steps: { id: string; type: string }[]) => steps.find((s) => /email_client_their_certificate$/.test(s.id))!;
      // Without a binding, the step is a person's task: XO sends nothing.
      assert.equal(emailStep(await generate()).type, 'approve');
      // A binding without arguments does not change that: the source declares no operation.
      const plain = {
        capability: 'Email the client their certificate',
        connector: 'email',
        kind: 'http',
        operation: 'send',
        sideEffect: 'write',
        adapter: 'email',
      };
      assert.equal((await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [plain] })).status, 200);
      assert.equal(emailStep(await generate()).type, 'approve');
      // With arguments, the operator states that XO sends it, and with exactly what.
      const args = {
        to: { field: 'email' },
        subject: { const: 'Your certificate' },
        body: { const: 'Your certificate is attached.' },
        attachmentSha256: { field: 'document_sha256' },
        attachmentFilename: { field: 'document_name' },
        attachmentContentType: { field: 'document_type' },
      };
      const put = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [{ ...plain, arguments: args }] });
      assert.equal(put.status, 200, put.bodyText);
      const steps = await generate();
      const act = emailStep(steps) as { type: string; inputs?: Record<string, unknown> };
      assert.equal(act.type, 'act');
      assert.ok(!steps.some((s) => /email_client_their_certificate_not_done$/.test(s.id)), 'no person is asked whether XO sent it');
      const { previous_decision: _p, ...mapped } = act.inputs ?? {};
      assert.deepEqual(mapped, {
        to: { from: 'item.email' },
        subject: { const: 'Your certificate' },
        body: { const: 'Your certificate is attached.' },
        attachmentSha256: { from: 'item.document_sha256' },
        attachmentFilename: { from: 'item.document_name' },
        attachmentContentType: { from: 'item.document_type' },
      });
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { name: string; effect: { class: string } }[] };
      }>().inventory;
      assert.equal(inv.capabilities.find((c) => c.name === 'Email the client their certificate')!.effect.class, 'write');
      const refused = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [{ ...plain, arguments: { to: { field: 'Email Address' } } }],
      });
      assert.equal(refused.status, 400);
    } finally {
      await server.stop();
    }
  });
});
