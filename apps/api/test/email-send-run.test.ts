/**
 * UW-10c (ADR 0042) — end to end: a declared `sendEmail` operation, bound by the workspace to the `email` adapter, runs as Workflow IR
 * after a readiness certificate, sends through a LOCAL FAKE Gmail with an attachment found by its content hash, and a recipient
 * that no rule or confirmed list allows is refused with no effect. Real providers were not used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Secret } from '@xo/connectors';
import type { AdapterCredential, AdapterCredentialHandle } from '@xo/adapters';
import { TestServer, withTempDir } from './test-helpers.js';
import { createMailAdapter } from '../src/email/mail-adapter.js';
import { workspaceAttachmentStore } from '../src/email/attachments.js';
import { readRecipientRules } from '../src/email/recipient-rules.js';
import { fakeGmail, newMailbox } from '../../../packages/connectors/test/mail-fakes.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Mail', version: '1' },
  paths: {
    '/send': {
      post: {
        operationId: 'sendEmail',
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

test('a certificate-gated run sends an email with a hash-bound attachment through the bound email adapter; a stranger is refused', async () => {
  await withTempDir('xo-api-mailrun-', async (dataDir) => {
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
          accessToken: new Secret('fake-token-run'),
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
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR, adapterFactories: new Map([['email', factory]]) });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      // The attachment is a workspace source, found by the hash of its bytes.
      const bytes = Buffer.from('Certificate of completion for Asha Rao');
      const sha = createHash('sha256').update(bytes).digest('hex');
      assert.equal((await server.request('POST', `/workspaces/${ws}/sources?filename=asha.txt`, bytes)).status, 201);
      assert.equal(
        (await server.request('PUT', `/workspaces/${ws}/email/recipient-rules`, { addresses: ['asha@client.example'] })).status,
        200,
      );

      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=mail.json`, Buffer.from(OPENAPI))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const put = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [{ capability: 'sendEmail', connector: 'email', kind: 'http', operation: 'send', sideEffect: 'write', adapter: 'email' }],
      });
      assert.equal(put.status, 200, put.bodyText);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string; name: string }[] };
      }>().inventory;
      const op = inv.capabilities.find((c) => c.name === 'sendEmail')!;
      assert.equal(
        (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(op.capabilityId)}/approve`))
          .status,
        200,
      );
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal: { text: 'send an email' } })
      ).json<{
        definition: { definitionId: string; lowered: { complete: boolean; issues: unknown[] } };
      }>().definition;
      assert.equal(def.lowered.complete, true, JSON.stringify(def.lowered.issues));
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
      }>();
      assert.equal(cert.status, 'READY');
      const input = {
        to: 'asha@client.example',
        subject: 'Your certificate',
        body: 'Attached.',
        attachmentSha256: sha,
        attachmentFilename: 'asha.txt',
        attachmentContentType: 'text/plain',
      };
      const run = await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`, {
        input,
        certificateId: cert.certificateId,
      });
      assert.equal(run.status, 201, run.bodyText);
      assert.equal(run.json<{ state: string }>().state, 'completed', run.bodyText);
      assert.equal(box.messages.length, 1);
      assert.ok(box.messages[0]!.data.includes(bytes.toString('base64').slice(0, 20)), 'the approved bytes were sent');
      assert.match(box.messages[0]!.data, /Message-ID: <xo\.[0-9a-f]{32}@firm\.example>/);

      // A recipient no rule allows: refused before anything is sent; the run does not complete.
      const refused = await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`, {
        input: { ...input, to: 'stranger@evil.example' },
        certificateId: cert.certificateId,
      });
      assert.notEqual(refused.json<{ state?: string }>().state, 'completed', refused.bodyText);
      assert.equal(box.messages.length, 1, 'nothing was sent to the stranger');
    } finally {
      await server.stop();
      await gm.close();
    }
  });
});
