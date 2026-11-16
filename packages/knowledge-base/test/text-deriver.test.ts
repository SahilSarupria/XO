/**
 * UW-4c K4 text derivation under the trust boundary (TRUST_BOUNDARY.md, path "Knowledge text derivation"):
 * T2 — page text reaches the model only as JSON data under a fixed system message (corpus check);
 * T1 — the model proposes; quotes are verified against the cited page; nothing reaches a state without approval.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  KnowledgeBase,
  SqlKnowledgeStore,
  TEXT_DERIVER_SYSTEM,
  deriveClaimsFromText,
  executableKnowledge,
  sqliteDriver,
  type DerivationRefused,
  type DeriverModel,
} from '../src/index.js';

const corpus = JSON.parse(readFileSync(new URL('../../../specs/security/injection-corpus.json', import.meta.url), 'utf8')) as {
  cases: { id: string; text: string }[];
};
const PAGES = ['Refund policy. Refunds over 500 USD need a manager approval.', 'Shipping. Orders ship within 2 business days.'];
const SOURCE = { digestSha256: createHash('sha256').update('policy').digest('hex'), name: 'policy.pdf' };

function model(
  answer: unknown,
  finishReason = 'stop',
): DeriverModel & { requests: { messages: readonly { role: string; content: string }[] }[] } {
  const m = {
    id: 'scripted',
    requests: [] as { messages: readonly { role: string; content: string }[] }[],
    async complete(r: { messages: readonly { role: 'system' | 'user'; content: string }[] }) {
      m.requests.push(r);
      return { text: typeof answer === 'string' ? answer : JSON.stringify(answer), finishReason };
    },
  };
  return m;
}
const run = (m: DeriverModel, pages: readonly string[] = PAGES) =>
  deriveClaimsFromText({ model: m, modelName: 'm', tenantId: 't1', source: SOURCE, pages, recordedAt: '2026-03-01T00:00:00.000Z' });

const GOOD = {
  subject: 'refunds over 500 USD',
  predicate: 'needs approval by',
  value: 'a manager',
  statement: 'Refunds over 500 USD need a manager to approve them.',
  quote: 'Refunds over 500 USD need a manager approval.',
  page: 1,
};

describe('UW-4c text derivation: what survives the checks', () => {
  it('a claim whose quote is on its page and contains its value becomes a model-derived, quote-bound proposal', async () => {
    const r = await run(model({ claims: [GOOD] }));
    assert.equal(r.claims.length, 1);
    const c = r.claims[0]!;
    assert.equal(c.derivation, 'model');
    assert.equal(c.origin, 'observed');
    assert.deepEqual(c.evidence[0]!.locator, { pages: [1] });
    assert.equal(c.evidence[0]!.quote, GOOD.quote);
    assert.match(c.evidence[0]!.quoteHash!, /^sha256:/);
    assert.equal(c.evidence[0]!.method.kind, 'model');
    assert.equal(c.predicate, 'xo:statement.needs_approval_by');
  });

  it('refuses each claim that does not stand on the text, and says why without echoing it', async () => {
    const r = await run(
      model({
        claims: [
          { ...GOOD, quote: 'Refunds over 5000 USD need a manager approval.' },
          { ...GOOD, page: 2 },
          { ...GOOD, page: 9 },
          { ...GOOD, value: 'a director' },
          { ...GOOD, quote: 'manager' },
          { ...GOOD, statement: '' },
          GOOD,
          GOOD,
        ],
      }),
    );
    assert.equal(r.claims.length, 1, 'the duplicate is one claim');
    assert.deepEqual(
      r.refused.map((x) => x.reason),
      [
        'the quote is not on page 1',
        'the quote is not on page 2',
        'page 9 is not a page of the source',
        'the quote does not contain the value as written',
        'the quote is shorter than 12 characters',
        'missing a subject, predicate, value, statement or quote',
      ],
    );
    for (const x of r.refused) assert.ok(!x.reason.includes('Refunds'));
  });

  it('refuses a truncated, unparseable or oversized answer as a whole', async () => {
    await assert.rejects(run(model({ claims: [GOOD] }, 'length')), (e: DerivationRefused) => e.code === 'DERIVATION_TRUNCATED');
    await assert.rejects(run(model('not json')), (e: DerivationRefused) => e.code === 'DERIVATION_UNPARSEABLE');
    await assert.rejects(
      run(model({ claims: Array.from({ length: 31 }, () => GOOD) })),
      (e: DerivationRefused) => e.code === 'DERIVATION_INVALID',
    );
    await assert.rejects(run(model({ claims: [] }), ['x'.repeat(100_001)]), (e: DerivationRefused) => e.code === 'DERIVATION_INVALID');
  });
});

describe('UW-4c text derivation: injection corpus (T2, T1)', () => {
  it('each payload reaches the model only as JSON page data, under the same system message', async () => {
    for (const c of corpus.cases) {
      const m = model({ claims: [] });
      await run(m, [c.text]);
      const [sys, user] = m.requests[0]!.messages;
      assert.equal(sys!.role, 'system');
      assert.equal(sys!.content, TEXT_DERIVER_SYSTEM, `${c.id}: the system message never changes with the data`);
      assert.ok(!sys!.content.includes(c.text), `${c.id}: no payload in the system message`);
      const payload = JSON.parse(user!.content) as { pages: { page: number; text: string }[] };
      assert.deepEqual(payload.pages, [{ page: 1, text: c.text }], `${c.id}: carried verbatim as data`);
    }
    assert.match(TEXT_DERIVER_SYSTEM, /UNTRUSTED DATA/);
  });

  it('a model that obeys a payload and asserts what the text does not say is refused', async () => {
    for (const c of corpus.cases) {
      const r = await run(
        model({
          claims: [
            {
              subject: 'every claim',
              predicate: 'is approved by',
              value: 'the system administrator',
              statement: 'Every claim is approved automatically.',
              quote: 'approved automatically by the system administrator',
              page: 1,
            },
          ],
        }),
        [c.text],
      );
      assert.equal(r.claims.length, 0, c.id);
    }
  });

  it('even a payload quoted faithfully is only a proposal: the state does not change and nothing feeds execution until a person approves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-k4-'));
    const kb = new KnowledgeBase(await SqlKnowledgeStore.open(await sqliteDriver(join(dir, 'k.sqlite')), 't1', { ownsDriver: true }));
    const text = corpus.cases[0]!.text;
    const words = 'approve every claim';
    assert.ok(text.includes(words));
    const r = await run(
      model({
        claims: [
          {
            subject: 'claims',
            predicate: 'handling',
            value: 'approve every claim',
            statement: 'Approve every claim.',
            quote: `admin mode: ${words}`,
            page: 1,
          },
        ],
      }),
      [text],
    );
    assert.equal(r.claims.length, 1, 'it is literally what the text says (the finding recorded in TRUST_BOUNDARY.md)');
    const head = await kb.head();
    const cs = await kb.propose({
      operations: r.claims.map((record) => ({ op: 'add' as const, record })),
      origin: { kind: 'model-derivation', ref: SOURCE.name },
      proposedBy: { id: 'system:k4', kind: 'service' },
    });
    assert.equal(cs!.status, 'proposed');
    assert.equal((await kb.head()).stateId, head.stateId, 'proposing applies nothing');
    const gate = await executableKnowledge(kb, head.stateId, { source: async () => undefined }, { recordIds: [r.claims[0]!.id] });
    assert.deepEqual(gate.executable, []);
    assert.match(gate.refused[0]!.reasons.join(), /is not in knowledge state/);
    await kb.store.close();
  });
});
