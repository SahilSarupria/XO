import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Retriever, HybridRetriever, StructuredLookupRetriever, type KnowledgeRetriever, type RetrievedConcept } from '../../src/knowledge-layer/retrieval.js';
import type { DomainKnowledgePack } from '../../src/knowledge-layer/types.js';

// A tiny, invented pack: retrieval behaviour is tested independently of any real domain's content.
const PACK: DomainKnowledgePack = {
  id: 'test-pack',
  version: '1.0.0',
  domain: 'testing',
  description: 'fixture',
  provenance: 'authored for tests',
  status: 'draft',
  concepts: [
    { id: 'widget', label: 'widget', kind: 'entity', definition: 'A self-contained unit of production output.', synonyms: ['gizmo'], weight: 1 },
    { id: 'lead-time', label: 'lead time', kind: 'term', definition: 'Elapsed time between placing an order and receiving it.', synonyms: ['turnaround'], weight: 1 },
    { id: 'tolerance', label: 'tolerance', kind: 'constraint', definition: 'Permitted deviation from a nominal quantity.', synonyms: [], weight: 0.4 },
  ],
  relationships: [{ from: 'widget', type: 'has', to: 'lead-time' }],
  patterns: [],
};

test('structured lookup matches labels and synonyms as whole phrases, case-insensitively, with plural tolerance', () => {
  const r = new StructuredLookupRetriever([PACK]).retrieve('The GIZMOs have a long Lead Time.', 5);
  assert.deepEqual(r.map((x) => x.conceptId).sort(), ['lead-time', 'widget']);
  for (const x of r) assert.equal(x.provenance[0]!.engine, 'structured');
});

test('structured lookup does not match inside other words', () => {
  assert.deepEqual(new StructuredLookupRetriever([PACK]).retrieve('The widgetry and tolerances of ledgers', 5).map((x) => x.conceptId), ['tolerance']);
});

test('BM25 finds a concept from a descriptive query that never names it (conceptual, term-level)', () => {
  const r = new Bm25Retriever([PACK]).retrieve('how long between placing an order and receiving it', 3);
  assert.equal(r[0]!.conceptId, 'lead-time');
  assert.equal(r[0]!.provenance[0]!.engine, 'bm25');
});

test('BM25 returns nothing for a query with no overlapping vocabulary', () => {
  assert.deepEqual(new Bm25Retriever([PACK]).retrieve('xyzzy plugh', 5), []);
});

test('hybrid retrieval fuses engines (reciprocal rank fusion) and keeps WHERE each item came from', () => {
  const hybrid = new HybridRetriever([new StructuredLookupRetriever([PACK]), new Bm25Retriever([PACK])]);
  const r = hybrid.retrieve('lead time between placing an order and receiving it', 5);
  const lead = r.find((x) => x.conceptId === 'lead-time')!;
  assert.deepEqual(lead.provenance.map((p) => p.engine).sort(), ['bm25', 'structured']);
  assert.equal(r[0]!.conceptId, 'lead-time'); // agreement between engines ranks it first
  assert.ok(lead.score > 0);
});

test('a third (e.g. vector) engine plugs into the same interface; its provenance is preserved', () => {
  const fakeVector: KnowledgeRetriever = {
    retrieve: (): RetrievedConcept[] => [
      { packId: 'test-pack', conceptId: 'tolerance', label: 'tolerance', definition: 'x', score: 0.9, provenance: [{ engine: 'vector', rank: 1, rawScore: 0.9 }] },
    ],
  };
  const r = new HybridRetriever([new StructuredLookupRetriever([PACK]), fakeVector]).retrieve('gizmo', 5);
  assert.ok(r.some((x) => x.conceptId === 'tolerance' && x.provenance[0]!.engine === 'vector'));
  assert.ok(r.some((x) => x.conceptId === 'widget'));
});

test('retrieval is deterministic and respects k', () => {
  const h = new HybridRetriever([new StructuredLookupRetriever([PACK]), new Bm25Retriever([PACK])]);
  assert.deepEqual(h.retrieve('gizmo lead time tolerance', 5), h.retrieve('gizmo lead time tolerance', 5));
  assert.equal(h.retrieve('gizmo lead time tolerance', 1).length, 1);
});
