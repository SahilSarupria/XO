/** UW-10c (ADR 0042): recipient rules, confirmed contacts, attachments by hash, and the `email` adapter, against LOCAL FAKE providers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NonProductionAuditSink } from '@xo/audit';
import { Secret } from '@xo/connectors';
import type { AdapterCredential, AdapterCredentialHandle } from '@xo/adapters';
import { TestServer, withTempDir } from './test-helpers.js';
import { createMailAdapter } from '../src/email/mail-adapter.js';
import { workspaceAttachmentStore } from '../src/email/attachments.js';
import { confirmedContactEmails } from '../src/email/confirmed-contacts.js';
import { FsSourceStore } from '../src/sources/fs-source-store.js';
import { workspaceSourcesStore } from '../src/workspace/workspace-context.js';
import { fakeGmail, newMailbox } from '../../../packages/connectors/test/mail-fakes.js';

const PDF = Buffer.from('%PDF-1.4 certificate');
const SHA = createHash('sha256').update(PDF).digest('hex');

test('recipient rules: manage role, strict body, revision guard, counts-only audit; viewers cannot change them', async () => {
  await withTempDir('xo-api-mail-', async (dataDir) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const url = `/workspaces/${ws}/email/recipient-rules`;
      assert.deepEqual((await server.request('GET', url)).json(), { revision: 0, addresses: [], domains: [] });
      const put = await server.request('PUT', url, {
        addresses: ['Boss@Client.example'],
        domains: ['partner.example'],
        expectedRevision: 0,
      });
      assert.equal(put.status, 200, put.bodyText);
      const stored = put.json<{ revision: number; addresses: string[] }>();
      assert.equal(stored.revision, 1);
      assert.deepEqual(stored.addresses, ['boss@client.example']);
      assert.equal((await server.request('PUT', url, { addresses: [], expectedRevision: 0 })).status, 412);
      assert.equal((await server.request('PUT', url, { addresses: ['not-an-address'] })).status, 400);
      assert.equal((await server.request('PUT', url, { domains: ['x'] })).status, 400);
      assert.equal((await server.request('PUT', url, { surprise: 1 })).status, 400);
      const viewer = await server.issueAdditionalIdentity('viewer-mail');
      await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'viewer-mail', role: 'viewer' });
      assert.equal((await server.request('PUT', url, { addresses: ['x@y.example'] }, TestServer.authHeader(viewer.apiKey))).status, 403);
      assert.equal(
        (await server.request('GET', `/workspaces/${ws}/email/provider-guess?address=a%40gmail.com`)).json<{ tier: string }>().tier,
        'native_api',
      );
      assert.equal((await server.request('GET', `/workspaces/${ws}/email/provider-guess?address=nope`)).status, 400);
      // The default server installs the `email` adapter, so a binding that names it reports it installed.
      const bound = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [{ capability: 'sendEmail', connector: 'email', kind: 'http', operation: 'send', sideEffect: 'write', adapter: 'email' }],
      });
      assert.equal(bound.status, 200, bound.bodyText);
      assert.equal(
        (await server.request('GET', `/workspaces/${ws}/connector-bindings`)).json<{ bindings: { adapterInstalled: boolean }[] }>()
          .bindings[0]!.adapterInstalled,
        true,
      );
      assert.ok(sink.events().some((e) => e.type === 'email.recipient-rules.updated'));
      assert.ok(!/client\.example|partner\.example/.test(JSON.stringify(sink.events())), 'no addresses in audit');
    } finally {
      await server.stop();
    }
  });
});

const ws = { workspaceId: 'ws_mailtest' } as never;

async function withWorkspace(run: (config: never) => Promise<void>): Promise<void> {
  await withTempDir('xo-api-mail2-', async (dataRootDir) => run({ dataRootDir } as never));
}

test('attachments are found by content hash; a retired or unknown hash is not found', async () => {
  await withWorkspace(async (config) => {
    const sources = new FsSourceStore(workspaceSourcesStore(ws, config));
    const made = await sources.create('ws_mailtest', 'id1', {
      originalFilename: 'asha.pdf',
      mediaType: 'application/pdf',
      extension: '.pdf',
      bytes: PDF,
    });
    assert.ok(made.ok);
    const store = workspaceAttachmentStore(ws, config);
    assert.deepEqual(Buffer.from((await store.read(SHA))!), PDF);
    assert.equal(await store.read('0'.repeat(64)), undefined);
  });
});

test('confirmed contact lists give the allowed addresses; an unconfirmed or changed table gives none', async () => {
  await withWorkspace(async (config) => {
    const csv = Buffer.from('Name,Email\nAsha Rao,asha@client.example\nBala K,bala@client.example\nNo Mail,\n');
    const sources = new FsSourceStore(workspaceSourcesStore(ws, config));
    const made = await sources.create('ws_mailtest', 'id1', {
      originalFilename: 'clients.csv',
      mediaType: 'text/csv',
      extension: '.csv',
      bytes: csv,
    });
    assert.ok(made.ok);
    const digest = createHash('sha256').update(csv).digest('hex');
    const item = { key: 'clients.csv', name: 'clients.csv', extension: '.csv', sourceId: made.value.sourceId, digestSha256: digest };
    const conn = (decision: 'confirmed' | undefined, digests = [digest]) => ({
      list: async () =>
        [
          {
            connectionId: 'scn_1',
            items: [item],
            proposals: [
              {
                proposalId: 'p1',
                role: 'contact_list',
                label: 'a client list',
                basis: [],
                strength: 'strong',
                target: { kind: 'table', itemKey: 'clients.csv', recordSetId: 'rs_missing' },
              },
            ],
            decisions: decision === undefined ? [] : [{ proposalId: 'p1', decision, by: 'id1', at: '2026-11-18T00:00:00Z', digests }],
          },
        ] as never,
    });
    // The record-set id is read from the parsed table, so discover it the way the route does.
    const { tabularFromCsv } = await import('@xo/compiler');
    const t = tabularFromCsv(csv.toString());
    assert.ok(t.ok);
    const rsId = t.value.recordSets[0]!.id;
    const withId = (c: ReturnType<typeof conn>) => ({
      list: async () =>
        (await c.list()).map((x: never) => ({
          ...(x as object),
          proposals: [
            { ...(x as { proposals: object[] }).proposals[0]!, target: { kind: 'table', itemKey: 'clients.csv', recordSetId: rsId } },
          ],
        })) as never,
    });
    assert.deepEqual([...(await confirmedContactEmails(ws, config, withId(conn('confirmed'))))].sort(), [
      'asha@client.example',
      'bala@client.example',
    ]);
    assert.equal((await confirmedContactEmails(ws, config, withId(conn(undefined)))).size, 0, 'proposed is not confirmed');
    assert.equal(
      (await confirmedContactEmails(ws, config, withId(conn('confirmed', ['0'.repeat(64)])))).size,
      0,
      'a table changed since it was confirmed must be confirmed again',
    );
  });
});

const handle = (
  over: Partial<AdapterCredentialHandle['record']> = {},
  secrets: Partial<AdapterCredentialHandle> = {},
): AdapterCredential => ({
  use: async (fn) =>
    fn({
      record: {
        provider: 'google',
        kind: 'oauth',
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
        accountLabel: 'office@firm.example',
        ...over,
      },
      accessToken: new Secret('fake-token-1'),
      ...secrets,
    } as AdapterCredentialHandle),
});

test('the email adapter sends through Gmail with a hash-checked attachment and maps results to effect states', async () => {
  const box = newMailbox();
  const gm = await fakeGmail(box, { limitAfter: 1 });
  try {
    const adapter = createMailAdapter({
      env: {},
      attachments: { read: async (h) => (h === SHA ? PDF : undefined) },
      recipientPolicy: async () => ({ confirmed: new Set(['asha@client.example']), rules: { addresses: [], domains: [] } }),
      endpoints: { gmail: gm.baseUrl, egress: { allowPrivateNetwork: true, allowedPorts: [Number(new URL(gm.baseUrl).port)] } },
    });
    const input = {
      to: ['asha@client.example'],
      subject: 'Your certificate',
      body: 'Attached.',
      attachments: [{ filename: 'asha.pdf', contentType: 'application/pdf', sha256: SHA }],
    };
    const req = (key: string, i: Record<string, unknown> = input, credential: AdapterCredential | undefined = handle(), op = 'send') => ({
      capabilityId: `email.${op}`,
      dispatchKey: key,
      input: i,
      ...(credential !== undefined ? { credential } : {}),
    });
    const ok = await adapter.invoke(req('k1'));
    assert.equal(ok.kind, 'confirmed_success');
    assert.equal(box.messages.length, 1);
    // Not allowed: refused with no effect, nothing reaches the provider.
    const denied = await adapter.invoke(req('k2', { ...input, to: ['stranger@evil.example'] }));
    assert.equal(denied.kind, 'confirmed_failure_no_effect');
    // Substituted attachment hash: no effect.
    const swapped = await adapter.invoke(req('k3', { ...input, attachments: [{ ...input.attachments[0]!, sha256: '1'.repeat(64) }] }));
    assert.equal(swapped.kind, 'confirmed_failure_no_effect');
    assert.equal(box.messages.length, 1);
    // Provider limit: no effect, and the batch stops.
    const limited = await adapter.invoke(req('k4'));
    assert.equal(limited.kind, 'confirmed_failure_no_effect');
    // No connection bound.
    assert.equal((await adapter.invoke(req('k5', input, undefined))).kind, 'confirmed_failure_no_effect');
    // Lookup: without a read scope the adapter cannot look, which is UNKNOWN, never "not sent".
    const noLookup = await adapter.invoke(req('k1', {}, handle(), 'find_sent'));
    assert.equal(noLookup.kind, 'outcome_unknown');
    const readable = handle({ scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'] });
    const found = await adapter.invoke(req('k1', {}, readable, 'find_sent'));
    assert.deepEqual(found, { kind: 'confirmed_success', output: { found: true } });
    const missing = await adapter.invoke(req('never-sent', {}, readable, 'find_sent'));
    assert.equal(missing.kind, 'outcome_unknown');
    // Unknown operation.
    assert.equal((await adapter.invoke(req('k6', {}, handle(), 'delete'))).kind, 'confirmed_failure_no_effect');
  } finally {
    await gm.close();
  }
});

test('a connection that cannot say its sender, or an unreachable SMTP host, is a no-effect refusal', async () => {
  const adapter = createMailAdapter({
    env: {},
    attachments: { read: async () => undefined },
    recipientPolicy: async () => ({ confirmed: new Set(), rules: { addresses: ['a@b.example'], domains: [] } }),
  });
  const input = { to: ['a@b.example'], subject: 's', body: 'b', attachments: [] };
  const noSender = await adapter.invoke({
    capabilityId: 'email.send',
    dispatchKey: 'x',
    input,
    credential: handle({ accountLabel: undefined }),
  });
  assert.equal(noSender.kind, 'confirmed_failure_no_effect');
  const refused = await adapter.invoke({
    capabilityId: 'email.send',
    dispatchKey: 'y',
    input,
    credential: handle(
      { kind: 'basic', provider: 'smtp', host: '127.0.0.1:1', username: 'me@firm.example', scopes: [] },
      { password: new Secret('pw') },
    ),
  });
  assert.equal(refused.kind, 'confirmed_failure_no_effect', 'connection refused before anything was sent');
});

test('the tier an email connection sends in, and whether it can look up a sent message, follow from its record', async () => {
  const { emailTierOf } = await import('../src/email/mail-adapter.js');
  const gmail = (scopes: string[]) => emailTierOf({ kind: 'oauth', provider: 'google', scopes });
  assert.deepEqual(
    [gmail(['https://www.googleapis.com/auth/gmail.send'])?.tier, gmail(['https://www.googleapis.com/auth/gmail.send'])?.lookup],
    ['native_api', false],
  );
  assert.match(gmail(['https://www.googleapis.com/auth/gmail.send'])!.explanation, /waits for a person/);
  assert.equal(gmail(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'])?.lookup, true);
  // Microsoft scopes may come back with the Graph prefix; Mail.Read alone is not the lookup capability.
  assert.equal(
    emailTierOf({ kind: 'oauth', provider: 'microsoft', scopes: ['https://graph.microsoft.com/Mail.ReadBasic', 'Mail.Send'] })?.lookup,
    true,
  );
  assert.equal(emailTierOf({ kind: 'oauth', provider: 'microsoft', scopes: ['Mail.Send'] })?.lookup, false);
  assert.deepEqual(
    emailTierOf({ kind: 'basic', provider: 'smtp', host: 'smtp.x.example:587|imap.x.example:993', scopes: [] })?.tier,
    'smtp_imap',
  );
  assert.deepEqual(emailTierOf({ kind: 'basic', provider: 'smtp', host: 'smtp.x.example:587', scopes: [] })?.tier, 'send_only');
  assert.equal(emailTierOf({ kind: 'oauth', provider: 'other', scopes: [] }), undefined);
});
