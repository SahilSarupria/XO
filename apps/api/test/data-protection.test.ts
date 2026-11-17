// UW-14c–e (ADR 0037) — the workspace's own values never reach a hosted model: the known-value dictionary built from its
// spreadsheets, the leak guard at the one provider boundary, audit with hashes only, and token vaults erased with the workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ScriptableTestProvider, resolveResidency, type ResidencyPolicy } from '@xo/ai-core';
import { NonProductionAuditSink, type AuditEvent } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { classifyColumn, eraseTokenVault, sweepTokenVaults, TokenVaultStore } from '../src/protection/data-protection.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import type { WorkspaceDataConfig } from '../src/workspace/workspace-context.js';

const reply = (text: string) => ({
  kind: 'success' as const,
  response: { text, usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' as const },
});

/** Canary values: in the workspace's spreadsheet, then planted in every channel a request can be built from. */
const CLIENTS_CSV = [
  'Client name,Email,Mobile,Policy no,Premium',
  'Zephyrine Okonkwo-Bhat,zephyrine.ob@clientmail.in,9876501234,POL-88123,1200',
  'Tarquin Vellodi,t.vellodi@clientmail.in,9123405678,POL-88124,900',
].join('\n');
const CANARIES = ['zephyrine', 'okonkwo', 'vellodi', 'tarquin', 'clientmail', '9876501234', '98765 01234', '9123405678', '88123', '88124'];
const noCanary = (text: string, where: string): void => {
  const t = text.toLowerCase();
  for (const c of CANARIES) assert.ok(!t.includes(c), `canary "${c}" in ${where}`);
};

async function withWorkspace<T>(
  residency: ResidencyPolicy,
  fn: (c: {
    server: TestServer;
    base: string;
    hosted: ScriptableTestProvider;
    sink: NonProductionAuditSink;
    dataDir: string;
  }) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const hosted = new ScriptableTestProvider(
        'anthropic',
        Array.from({ length: 20 }, () => reply('fine')),
      );
      const sink = new NonProductionAuditSink();
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        residency,
        auditSink: sink,
        chatProviderFactory: (id) => (id === 'anthropic' ? hosted : undefined),
      });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const up = await server.request('POST', `${base}/sources?filename=clients.csv`, Buffer.from(CLIENTS_CSV));
        assert.equal(up.status, 201, up.bodyText);
        await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'anthropic', model: 'claude' } } });
        return await fn({ server, base, hosted, sink, dataDir });
      } finally {
        await server.stop();
      }
    }),
  );
}

const blockedEvents = (sink: NonProductionAuditSink): AuditEvent[] => sink.events().filter((e) => e.type === 'model.egress.blocked');

test('UAC-24: canaries from the workspace’s spreadsheet never reach a hosted model, whatever channel they arrive in', async () => {
  await withWorkspace(resolveResidency({ XO_RESIDENCY: 'open' }), async ({ server, base, hosted, sink }) => {
    const b64 = Buffer.from('{"email":"t.vellodi@clientmail.in"}').toString('base64');
    const channels: Record<string, string> = {
      prompt: 'Draft a renewal note for Zephyrine Okonkwo-Bhat',
      misspelt: 'Draft a renewal note for Zephyrin Okonkwo-Bhat',
      initials: 'Draft a renewal note for T. Vellodi',
      'file name': 'Summarise zephyrine_okonkwo-bhat_policy.pdf',
      'folder name': 'What is in /clients/TarquinVellodi/2026/ ?',
      'pdf text': 'Extracted page text: Insured: VELLODI, Tarquin. Sum assured 5,00,000.',
      'error path': "ENOENT: no such file '/data/Tarquin Vellodi/statement.xlsx'",
      'cell value': 'The email column says zephyrine.ob@clientmail.in',
      phone: 'Call her on 98765 01234',
      'policy id': 'Look up pol 88123',
      base64: `Decode this: ${b64}`,
      'look-alike letters': 'Draft a note for Таrquin Vеllodi', // Cyrillic Т and е
    };
    const thread = (await server.request('POST', `${base}/chats`, {})).json<{ threadId: string }>().threadId;
    for (const [channel, content] of Object.entries(channels)) {
      const res = await server.request('POST', `${base}/chats/${thread}/messages`, { content });
      assert.equal(res.status, 412, `${channel}: ${res.bodyText}`);
      assert.match(res.bodyText, /not sent to the hosted model: the request carries \d+ protected value/, channel);
    }
    assert.equal(hosted.callLog.length, 0, 'nothing reached the provider');

    // A request with no protected value goes, and the refused ones left nothing in the conversation it carries.
    const ok = await server.request('POST', `${base}/chats/${thread}/messages`, { content: 'Which renewals are due this month?' });
    assert.equal(ok.status, 201, ok.bodyText);
    assert.equal(hosted.callLog.length, 1);
    noCanary(JSON.stringify(hosted.callLog), 'what the provider received');

    // Every refusal is audited with kinds and hashes, never a value.
    const events = blockedEvents(sink);
    assert.equal(events.length, Object.keys(channels).length);
    for (const e of events) {
      assert.equal(e.outcome, 'denied');
      assert.match(String(e.metadata?.['hashes']), /^sha256:[0-9a-f]{16}(,sha256:[0-9a-f]{16})*$/);
    }
    noCanary(JSON.stringify(sink.events()), 'the audit trail');
  });
});

test('UAC-24: the scan preview finds what the guard would, and masks it, without naming the dictionary entry', async () => {
  await withWorkspace(resolveResidency({}), async ({ server, base }) => {
    const res = await server.request('POST', `${base}/data-protection/scan`, {
      text: 'Tell Zephyrine Okonkwo-Bhat (PAN ABCPE1234F) about POL-88124',
    });
    assert.equal(res.status, 200, res.bodyText);
    const body = res.json<{ blocked: boolean; masked: string; hits: { entity: string; detector: string }[] }>();
    assert.equal(body.blocked, true);
    assert.equal(body.masked, 'Tell [PERSON] (PAN [PAN]) about [ID]');
    assert.deepEqual([...new Set(body.hits.map((h) => h.entity))].sort(), ['ID', 'PAN', 'PERSON']);

    const view = await server.request('GET', `${base}/data-protection`);
    assert.equal(view.status, 200, view.bodyText);
    const dp = view.json<{ dictionary: { knownValues: number; columns: { header: string; kind: string }[] } }>();
    assert.deepEqual(
      dp.dictionary.columns.map((c) => `${c.header}:${c.kind}`),
      ['Client name:name', 'Email:email', 'Mobile:phone', 'Policy no:identifier'],
      'Premium is not identifying',
    );
    noCanary(view.bodyText, 'the dictionary view');
  });
});

test('data-protection settings: added values are protected at once; ignored columns are not; changes are audited with counts', async () => {
  await withWorkspace(resolveResidency({ XO_RESIDENCY: 'open' }), async ({ server, base, hosted, sink }) => {
    const put = await server.request('PUT', `${base}/data-protection`, {
      values: [{ value: 'Project Nightjar', kind: 'other' }],
      ignoreColumns: ['Policy no'],
      expectedRevision: 0,
    });
    assert.equal(put.status, 200, put.bodyText);
    const thread = (await server.request('POST', `${base}/chats`, {})).json<{ threadId: string }>().threadId;
    const refused = await server.request('POST', `${base}/chats/${thread}/messages`, { content: 'Status of project nightjar?' });
    assert.equal(refused.status, 412, refused.bodyText);
    const sent = await server.request('POST', `${base}/chats/${thread}/messages`, { content: 'What does POL-88123 cover?' });
    assert.equal(sent.status, 201, 'the policy column is no longer protected');
    assert.equal(hosted.callLog.length, 1);

    const stale = await server.request('PUT', `${base}/data-protection`, { values: [], expectedRevision: 0 });
    assert.equal(stale.status, 412);
    const bad = await server.request('PUT', `${base}/data-protection`, { values: [{ value: 'x', kind: 'secret' }] });
    assert.equal(bad.status, 400);
    const updated = sink.events().filter((e) => e.type === 'data-protection.updated');
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.metadata?.['values'], 1);
    assert.ok(!JSON.stringify(updated).toLowerCase().includes('nightjar'));
  });
});

test('masked_hosted: a hosted call made outside any workspace context is refused by the leak guard (fail-closed)', async () => {
  const { guardProvider, getInferenceDenial } = await import('@xo/ai-core');
  const hosted = new ScriptableTestProvider('anthropic', [reply('no')]);
  const g = guardProvider(hosted, resolveResidency({ XO_RESIDENCY: 'masked_hosted', XO_HOSTED_MODEL_PROVIDERS: 'anthropic' }));
  // Even a typed request: with no workspace context there is no dictionary to check it against.
  const { buildEgressRequest, defineTemplate } = await import('@xo/ai-core');
  const typed = buildEgressRequest({
    model: 'm',
    maxOutputTokens: 5,
    messages: [{ role: 'user', parts: [defineTemplate('t/x', 'Say hello.')] }],
  });
  assert.equal(getInferenceDenial(await g.complete(typed).catch((e: unknown) => e))?.reason, 'leak_guard_unavailable');
  assert.equal(hosted.callLog.length, 0);
});

test('column classification: headers first, then what the values look like; ignored columns win', () => {
  const none = { protectColumns: [], ignoreColumns: [] };
  assert.equal(classifyColumn('Customer Name', [], none), 'name');
  assert.equal(classifyColumn('Insurer', [], none), 'organization');
  assert.equal(classifyColumn('PAN', [], none), 'identifier');
  assert.equal(classifyColumn('Contact', ['a@b.in', 'c@d.in'], none), 'email');
  assert.equal(classifyColumn('Notes', ['9876501234', '+91 91234 05678', ''], none), 'phone');
  assert.equal(classifyColumn('Premium', ['1200', '900'], none), undefined);
  assert.equal(classifyColumn('Product name', [], { protectColumns: [], ignoreColumns: ['product name'] }), undefined);
  assert.equal(classifyColumn('Codename', [], { protectColumns: ['Codename'], ignoreColumns: [] }), 'other');
});

test('UAC-26: token vaults are sealed per workspace, kept for their retention, swept after it, and erased on archive', async () => {
  await withTempDir('xo-vaults-', async (dataRootDir) => {
    const ws = { workspaceId: 'ws_vault_test' } as WorkspaceRecord;
    const config = { dataRootDir } as WorkspaceDataConfig;
    const credentials = { masterKey: randomBytes(32), clients: { google: undefined, microsoft: undefined }, redirectUri: 'x' };
    const store = new TokenVaultStore(ws, config, credentials, 7);
    const t0 = new Date('2026-11-16T00:00:00Z');
    const v = await store.open('wfl_a', t0);
    assert.equal(v.tokenize('Tarquin Vellodi', 'CLIENT'), 'CLIENT_0001');
    await store.save(v);
    const files = await readdir(join(dataRootDir, ws.workspaceId, 'token-vaults'));
    assert.deepEqual(files, ['wfl_a.vault']);
    noCanary(JSON.stringify(files), 'file names');
    const again = await store.open('wfl_a', new Date('2026-11-20T00:00:00Z'));
    assert.equal(again.resolve('CLIENT_0001')?.value, 'Tarquin Vellodi');
    // Another workspace's key does not open it.
    const other = new TokenVaultStore({ workspaceId: 'ws_other' } as WorkspaceRecord, config, credentials, 7);
    await mkdir(join(dataRootDir, 'ws_other', 'token-vaults'), { recursive: true });
    const { readFile } = await import('node:fs/promises');
    await writeFile(
      join(dataRootDir, 'ws_other', 'token-vaults', 'wfl_a.vault'),
      await readFile(join(dataRootDir, ws.workspaceId, 'token-vaults', 'wfl_a.vault')),
    );
    await assert.rejects(other.open('wfl_a', t0), /does not open/);

    // Past retention: the sweep erases it; nothing opens it again.
    assert.equal(await sweepTokenVaults(dataRootDir, ws.workspaceId, new Date('2026-11-22T00:00:00Z')), 0);
    assert.equal(await sweepTokenVaults(dataRootDir, ws.workspaceId, new Date('2026-11-24T00:00:00Z')), 1);
    assert.equal((await store.open('wfl_a', new Date('2026-11-24T00:00:00Z'))).size, 0);

    await store.save(await store.open('wfl_b', t0).then((x) => (x.tokenize('Zephyrine', 'CLIENT'), x)));
    assert.equal(await eraseTokenVault(dataRootDir, ws.workspaceId, 'wfl_b'), true);
    assert.equal(await eraseTokenVault(dataRootDir, ws.workspaceId, 'wfl_b'), false);
    assert.throws(() => eraseTokenVault(dataRootDir, ws.workspaceId, '../etc'), /scope is an id/);
  });
});
