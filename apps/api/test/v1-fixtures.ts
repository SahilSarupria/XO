import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { NonProductionAuditSink } from '@xo/audit';
import { Secret } from '@xo/connectors';
import type { AdapterCredential, AdapterCredentialHandle } from '@xo/adapters';
import { resolveResidency } from '@xo/ai-core';
import { TestServer } from './test-helpers.js';
import { createMailAdapter } from '../src/email/mail-adapter.js';
import { workspaceAttachmentStore } from '../src/email/attachments.js';
import { readRecipientRules } from '../src/email/recipient-rules.js';

/** The certificate-distribution vertical's fixtures, shared by `v1-certificate-flow.test.ts` and `domain-isolation.test.ts` (UW-13, G-3). */
export const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };

export const CLIENTS = [
  { name: 'Asha Rao', email: 'asha@client.example', file: 'Asha_Rao_certificate.pdf' },
  { name: 'Bilal Khan', email: 'bilal@client.example', file: 'bilal-khan-certificate.pdf' },
  { name: 'Chen Wei', email: 'chen@client.example', file: 'Certificate - Chen Wei.pdf' },
];
// Dev Patel has no certificate yet: XO leaves him out and says so, rather than sending him anything.
export const csv = `Client name,Email\n${CLIENTS.map((c) => `${c.name},${c.email}`).join('\n')}\nDev Patel,dev@client.example\n`;
export const certificate = (name: string) => Buffer.from(`%PDF-1.4\n% Certificate of completion for ${name}\n%%EOF\n`);

// The customer's procedure, in their own words.
export const PROCEDURE =
  '# Certificate distribution\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Email the client their certificate. | The client has their certificate. | Office manager |\n';
// The one thing an operator states: XO sends that step through the email connector, with these arguments.
export const SEND_BINDING = {
  capability: 'Email the client their certificate',
  connector: 'email',
  kind: 'http',
  operation: 'send',
  sideEffect: 'write',
  adapter: 'email',
  arguments: {
    to: { field: 'email' },
    subject: { const: 'Your certificate' },
    body: { const: 'Your certificate of completion is attached.' },
    attachmentSha256: { field: 'document_sha256' },
    attachmentFilename: { field: 'document_name' },
    attachmentContentType: { field: 'document_type' },
  },
};

// A declared send operation (the flat form of the email contract), for the tier check below.
export const SEND_OPERATION = JSON.stringify({
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

export interface Preview {
  previewId: string;
  itemsSource?: { label: string; counts: Record<string, number>; excludedRows: { row: number; reason: string }[] };
  root: string;
  counts: Record<string, number>;
  total: number;
  items: { index: number; state: string; actions: { args: Record<string, unknown> }[] }[];
  approval?: { approvalId: string };
}

/** The workspace, up to a READY certificate for "send each client their certificate", over a connected folder. */
export async function certificateWorkspace(
  dataDir: string,
  folderRoot: string,
  gmailUrl: string,
  options: { extraRows?: string; beforeCertify?: (server: TestServer, ws: string) => Promise<void> } = {},
) {
  const folder = join(folderRoot, 'Renewals');
  await mkdir(join(folder, 'Certificates'), { recursive: true });
  await writeFile(join(folder, 'clients.csv'), csv + (options.extraRows ?? ''));
  for (const c of CLIENTS) await writeFile(join(folder, 'Certificates', c.file), certificate(c.name));
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
      endpoints: { gmail: gmailUrl, egress: { allowPrivateNetwork: true, allowedPorts: [Number(new URL(gmailUrl).port)] } },
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
    env: { XO_SOURCE_FOLDER_ROOTS: folderRoot },
  });
  try {
    const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
    const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);

    // 1. The folder: XO reads it and proposes what it holds; a person confirms "each client's certificate".
    const connected = await server.request('POST', `/workspaces/${ws}/source-connections`, { kind: 'local_folder', root: folder });
    assert.equal(connected.status, 201, connected.bodyText);
    const conn = connected.json<{
      connection: { connectionId: string; proposals: { proposalId: string; role: string; label: string }[] };
    }>().connection;
    const pairing = conn.proposals.find((x) => x.role === 'per_person_documents')!;
    assert.equal(pairing.label, "each client's certificate");
    const confirmed = await server.request(
      'POST',
      `/workspaces/${ws}/source-connections/${conn.connectionId}/proposals/${pairing.proposalId}/decision`,
      { decision: 'confirmed' },
    );
    assert.equal(confirmed.status, 200, confirmed.bodyText);
    assert.equal((await server.request('PUT', `/workspaces/${ws}/email/recipient-rules`, { domains: ['client.example'] })).status, 200);

    // 2. The procedure in plain words; the send step bound once, with its arguments (V1-G1); composed per client.
    const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=procedure.md`, Buffer.from(PROCEDURE))).json<{
      sourceId: string;
    }>();
    const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
      .compilationId;
    const bound = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [SEND_BINDING] });
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
    await options.beforeCertify?.(server, ws);
    const ready = await server.request('POST', `${base}/readiness`, {});
    const cert = ready.json<{ certificateId: string; status: string }>();
    assert.equal(cert.status, 'READY', ready.bodyText);
    return { server, audit, ws, reviewer, base, cert, folder, connectionId: conn.connectionId, pairing };
  } catch (e) {
    await server.stop();
    throw e;
  }
}
