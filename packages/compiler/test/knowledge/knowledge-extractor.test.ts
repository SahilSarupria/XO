import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { KnowledgeExtractionOutput } from '@xo/ai-core';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { extractKnowledgeGraph } from '../../src/knowledge/knowledge-extractor.js';
import { hashKnowledgeGraph } from '../../src/knowledge/graph.js';
import { buildTestPdf, type TestPdfSpec } from '../pdf/fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

async function experienceDocFromPdf(spec: TestPdfSpec, documentPath = 'test.pdf') {
  const pdf = buildTestPdf(spec);
  const loaded = loader.load(pdf, documentPath);
  assert.ok(loaded.ok);
  if (!loaded.ok) throw loaded.error;
  const parsed = parseDocument(loaded.value);
  return chunkDocument(parsed, documentPath, loaded.value.metadata.title);
}

test('integration: a full PDF -> ExperienceDocument -> KnowledgeGraph pipeline produces typed nodes', async () => {
  const experienceDoc = await experienceDocFromPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Confidentiality) Tj ' +
          '/F1 12 Tf 0 -40 Td (Acme Corp shall protect all Confidential Information disclosed by the Client.) Tj',
      },
    ],
  });
  const graph = await extractKnowledgeGraph(experienceDoc);
  assert.ok(graph.nodes.length > 0);
  assert.ok(graph.nodes.some((n) => n.semanticType === 'obligation'));
  assert.ok(graph.nodes.some((n) => n.semanticType === 'organization' && n.canonicalLabel === 'Acme Corp'));
});

test('integration: every node traces back to a page and document path', async () => {
  const experienceDoc = await experienceDocFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Acme Corp is mentioned here.) Tj' }] }, 'contract.pdf');
  const graph = await extractKnowledgeGraph(experienceDoc);
  for (const node of graph.nodes) {
    for (const prov of node.provenance) {
      assert.equal(prov.documentPath, 'contract.pdf');
      assert.ok(prov.pages.length > 0);
    }
  }
});

test('integration: the same content mentioned across two units merges into one node with two provenance entries', async () => {
  const experienceDoc = await experienceDocFromPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Section A) Tj ' +
          '/F1 12 Tf 0 -40 Td (Acme Corp is the primary vendor.) Tj ' +
          '/F1 20 Tf 0 -60 Td (Section B) Tj ' +
          '/F1 12 Tf 0 -40 Td (Acme Corp also provides support services.) Tj',
      },
    ],
  });
  const graph = await extractKnowledgeGraph(experienceDoc);
  const acmeNode = graph.nodes.find((n) => n.canonicalLabel === 'Acme Corp');
  assert.ok(acmeNode);
  assert.ok(acmeNode!.provenance.length >= 2);
});

test('integration: rule-based-only extraction (no aiCore) still produces a correct graph', async () => {
  const experienceDoc = await experienceDocFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td ("Term" means a defined word.) Tj' }] });
  const graph = await extractKnowledgeGraph(experienceDoc); // no options.aiCore at all
  assert.ok(graph.nodes.some((n) => n.semanticType === 'definition' && n.canonicalLabel === 'Term'));
});

test('integration: with an AI extractor available, AI-derived nodes appear alongside rule-based ones', async () => {
  const experienceDoc = await experienceDocFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Acme Corp shall comply with all terms.) Tj' }] });
  const output: KnowledgeExtractionOutput = { items: [{ id: 'i1', type: 'concept', statement: 'Compliance obligation exists', domain: 'legal', confidence: 0.9 }], relationships: [] };
  const provider = new ScriptableTestProvider('anthropic', experienceDoc.units.map(() => ({ kind: 'success' as const, response: jsonResponse(output) })));
  const aiCore = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  const graph = await extractKnowledgeGraph(experienceDoc, { aiCore });
  assert.ok(graph.nodes.some((n) => n.canonicalLabel === 'Compliance obligation exists'));
  assert.ok(graph.nodes.some((n) => n.semanticType === 'organization')); // rule-based candidate still present too
});

test('integration: an unreachable AI provider degrades gracefully to rule-based output, never throwing', async () => {
  const experienceDoc = await experienceDocFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Acme Corp shall comply.) Tj' }] });
  const aiCore = new AiCapabilityLayer({ providers: [], policy: { rules: [] } }); // guaranteed to fail every call
  const graph = await extractKnowledgeGraph(experienceDoc, { aiCore });
  assert.ok(graph.nodes.length > 0);
  assert.ok(graph.nodes.some((n) => n.semanticType === 'organization'));
});

test('determinism: compiling the same document twice produces a byte-for-byte identical KnowledgeGraph (rule-based)', async () => {
  const spec: TestPdfSpec = {
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Definitions) Tj ' +
          '/F1 12 Tf 0 -40 Td ("Party" means a signatory. Acme Corp is a Party.) Tj',
      },
    ],
  };
  const docA = await experienceDocFromPdf(spec);
  const docB = await experienceDocFromPdf(spec);
  const graphA = await extractKnowledgeGraph(docA);
  const graphB = await extractKnowledgeGraph(docB);
  assert.deepEqual(graphA, graphB);
  assert.equal(hashKnowledgeGraph(graphA), hashKnowledgeGraph(graphB));
});

test('determinism: graph hash is stable across independent full pipeline runs from raw PDF bytes', async () => {
  const spec: TestPdfSpec = { pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Acme Corp shall comply with the Agreement.) Tj' }] };
  const pdfBytesA = buildTestPdf(spec);
  const pdfBytesB = buildTestPdf(spec);
  const loadedA = loader.load(pdfBytesA, 'x.pdf');
  const loadedB = loader.load(pdfBytesB, 'x.pdf');
  assert.ok(loadedA.ok && loadedB.ok);
  if (!loadedA.ok || !loadedB.ok) return;
  const graphA = await extractKnowledgeGraph(await chunkDocument(parseDocument(loadedA.value), 'x.pdf', undefined));
  const graphB = await extractKnowledgeGraph(await chunkDocument(parseDocument(loadedB.value), 'x.pdf', undefined));
  assert.equal(hashKnowledgeGraph(graphA), hashKnowledgeGraph(graphB));
});

test('a document with no units produces an empty but valid graph', async () => {
  const experienceDoc = await experienceDocFromPdf({ pages: [{ contentOps: 'q 1 0 0 RG 0 0 100 100 re S Q' }] }); // no text at all -> requiresOcr, no units
  const graph = await extractKnowledgeGraph(experienceDoc);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
});
