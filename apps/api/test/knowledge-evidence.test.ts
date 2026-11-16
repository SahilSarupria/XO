/**
 * UW-4a/4c — evidence that can be checked, the executable-use gate (UAC-12), and the state-keyed search over HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultSourceFrontendRegistry } from '@xo/compiler';
import { resolveRecordEvidence, type ClaimRecord } from '@xo/knowledge-base';
import { viewOfCanonicalSource } from '../src/knowledge/evidence-sources.js';
import { TestServer, withTempDir } from './test-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT = '# Refunds\n\nAcme Corp handles refunds.\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

async function findFile(root: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true }))
    if (e.isFile() && e.name === name) out.push(join(e.parentPath, e.name));
  return out;
}

interface Verdict {
  recordId: string;
  executable: boolean;
  reasons: string[];
}

test('approved compiled knowledge may feed execution while its source stands; an altered source stops it (UAC-12)', async () => {
  await withTempDir('xo-api-kbev-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const c1 = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const p = (await server.request('POST', `/workspaces/${ws}/compilations/${c1}/knowledge-change-sets`)).json<{
        changeSet: { changeSetId: string };
      }>();
      const before = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
      // Nothing proposed is executable: the proposed records are not in the head state at all.
      const unapproved = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${before}/executable`)).json<{
        verdicts: Verdict[];
      }>();
      assert.equal(unapproved.verdicts.length, 0);

      const state = (
        await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, { reason: 'ok' })
      ).json<{ state: { stateId: string; entries: unknown[] } }>().state;

      const verify = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${state.stateId}/verify`)).json<{
        verified: boolean;
        contentRoot: string;
      }>();
      assert.equal(verify.verified, true);
      assert.match(verify.contentRoot, /^sha256:[0-9a-f]{64}$/);

      const ok = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${state.stateId}/executable`)).json<{
        executable: string[];
        refused: Verdict[];
      }>();
      assert.deepEqual(ok.refused, []);
      assert.equal(ok.executable.length, state.entries.length);

      // The stored file changes under the knowledge: the cited version no longer exists as written.
      const contents = await findFile(join(dataDir, ws, 'sources'), 'content');
      assert.equal(contents.length, 1);
      await writeFile(contents[0]!, Buffer.from(TEXT.replace('500', '5000')));
      const stale = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${state.stateId}/executable`)).json<{
        executable: string[];
        refused: Verdict[];
      }>();
      assert.deepEqual(stale.executable, []);
      assert.equal(stale.refused.length, state.entries.length);
      for (const r of stale.refused) assert.match(r.reasons.join(' '), /refunds\.md: the stored bytes no longer match the cited digest/);
    } finally {
      await server.stop();
    }
  });
});

test('search reads approved knowledge by default and other lifecycles only when asked', async () => {
  await withTempDir('xo-api-kbev-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const c1 = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const p = (await server.request('POST', `/workspaces/${ws}/compilations/${c1}/knowledge-change-sets`)).json<{
        changeSet: { changeSetId: string };
      }>();
      await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, { reason: 'ok' });
      const plain = (await server.request('GET', `/workspaces/${ws}/knowledge/search?q=refund`)).json<{ hits: { lifecycle: string }[] }>();
      assert.ok(plain.hits.length > 0);
      assert.ok(plain.hits.every((h) => h.lifecycle === 'active'));
      const any = await server.request('GET', `/workspaces/${ws}/knowledge/search?q=refund&lifecycle=any`);
      assert.equal(any.status, 200);
      const bad = await server.request('GET', `/workspaces/${ws}/knowledge/search?q=refund&lifecycle=approved`);
      assert.equal(bad.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('the evidence view of a PDF has its pages, as the compiler read them; a scanned page is unreadable, not empty', async () => {
  const registry = createDefaultSourceFrontendRegistry();
  const read = async (name: string) => {
    const bytes = new Uint8Array(await readFile(join(here, '../../../packages/benchmark/xdomain/formats', name)));
    const r = registry.ingest({ kind: 'pdf', bytes, sourcePath: name });
    assert.ok(r.ok);
    return viewOfCanonicalSource(name, true, r.value);
  };
  const plain = await read('loan.plain.pdf');
  assert.equal(plain.pageCount, 1);
  const claim = (quote: string): ClaimRecord => ({
    kind: 'claim',
    id: 'clm_000000000000000000000001',
    tenantId: 't',
    type: 'xo:heuristic',
    subject: { literal: 'loan' },
    predicate: 'xo:heuristic',
    object: { value: 'x' },
    polarity: 'positive',
    authority: { level: 'source', basis: 'policy' },
    text: 'Staff may borrow equipment for up to 30 days',
    evidence: [
      {
        sourceDigestSha256: 'd',
        sourceName: 'loan.plain.pdf',
        locator: { pages: [1] },
        quote,
        method: { kind: 'source', name: 't', version: '1' },
      },
    ],
    derivation: 'source',
    confidence: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
  });
  const port = (v: typeof plain) => ({ source: async () => v });
  const found = await resolveRecordEvidence(claim('Staff may borrow equipment for up to 30 days.'), port(plain));
  assert.equal(found.evidence[0]!.status, 'resolved');
  assert.equal(found.evidence[0]!.words, 'found');
  const invented = await resolveRecordEvidence(claim('Staff may borrow equipment for up to 90 days.'), port(plain));
  assert.equal(invented.evidence[0]!.status, 'quote_not_found');

  const scanned = await read('loan.scanned.pdf');
  assert.deepEqual(scanned.unreadablePages, [1]);
  assert.equal((await resolveRecordEvidence(claim('Staff may borrow equipment'), port(scanned))).evidence[0]!.status, 'quote_unverifiable');
});

test('K4: a model reads a source and proposes quote-bound claims; ungrounded ones are refused; nothing is applied (T1)', async () => {
  const { ScriptableTestProvider, jsonResponse } = await import('@xo/ai-core');
  const provider = new ScriptableTestProvider('gemini', [
    {
      kind: 'success',
      response: jsonResponse({
        claims: [
          {
            subject: 'a refund over 500',
            predicate: 'outcome',
            value: 'denied',
            statement: 'A refund over 500 must be denied.',
            quote: 'If the refund amount exceeds 500, the refund must be denied.',
            page: 1,
          },
          {
            subject: 'refunds',
            predicate: 'approver',
            value: 'the CEO',
            statement: 'The CEO approves refunds.',
            quote: 'The CEO approves all refunds.',
            page: 1,
          },
        ],
      }),
    },
  ]);
  await withTempDir('xo-api-kbev-', async (dataDir) => {
    const server = await TestServer.start({
      workspaceDataDir: dataDir,
      ...NO_OCR,
      chatProviderFactory: (id) => (id === 'gemini' ? provider : undefined),
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      await server.request('PUT', `/workspaces/${ws}/settings`, { model: { primary: { provider: 'gemini', model: 'gemini-test' } } });
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const head = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
      const r = await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/knowledge-derivations`);
      assert.equal(r.status, 201, r.bodyText);
      const body = r.json<{
        changeSet: { changeSetId: string; status: string; origin: { kind: string } };
        proposed: number;
        refused: { reason: string }[];
      }>();
      assert.equal(body.proposed, 1);
      assert.deepEqual(
        body.refused.map((x) => x.reason),
        ['the quote is not on page 1'],
      );
      assert.equal(body.changeSet.status, 'proposed');
      assert.equal(body.changeSet.origin.kind, 'model-derivation');
      // The page text reached the model only as JSON data under the fixed system message.
      const [sys, user] = provider.callLog[0]!.messages;
      assert.match(String(sys!.content), /UNTRUSTED DATA/);
      assert.ok(!String(sys!.content).includes('refund'));
      assert.match(String(user!.content), /"pages":\[\{"page":1,"text":/);
      assert.equal(
        (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId,
        head,
        'nothing applied',
      );
      // Approved by a person, the claim's quote resolves against the stored source.
      const s = (
        await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${body.changeSet.changeSetId}/approve`, { reason: 'read it' })
      ).json<{ state: { stateId: string } }>().state;
      const ex = (await server.request('GET', `/workspaces/${ws}/knowledge/states/${s.stateId}/executable`)).json<{
        executable: string[];
        refused: Verdict[];
      }>();
      assert.equal(ex.executable.length, 1, JSON.stringify(ex.refused));
    } finally {
      await server.stop();
    }
  });
});
