import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { CapabilityExtractionOutput as AiCapabilityExtractionOutput } from '@xo/ai-core';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { extractKnowledgeGraph } from '../../src/knowledge/knowledge-extractor.js';
import { extractCapabilityGraph } from '../../src/capabilities/capability-extractor.js';
import { hashCapabilityGraph } from '../../src/capabilities/graph.js';
import { buildTestPdf, type TestPdfSpec } from '../pdf/fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

async function pipelineFromPdf(spec: TestPdfSpec, documentPath = 'test.pdf') {
  const pdf = buildTestPdf(spec);
  const loaded = loader.load(pdf, documentPath);
  assert.ok(loaded.ok);
  if (!loaded.ok) throw loaded.error;
  const parsed = parseDocument(loaded.value);
  const experienceDoc = await chunkDocument(parsed, documentPath, loaded.value.metadata.title);
  const knowledgeGraph = await extractKnowledgeGraph(experienceDoc);
  return { experienceDoc, knowledgeGraph };
}

test('integration: full pipeline (Stage 1-5) produces typed capabilities', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Notifications) Tj ' +
          '/F1 12 Tf 0 -40 Td (Acme Corp shall send a confirmation email to the Client upon completion.) Tj',
      },
    ],
  });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
  assert.ok(graph.capabilities.length > 0);
  assert.ok(graph.capabilities.some((c) => c.category === 'communication'));
});

test('integration: capabilities carry provenance back to the source document', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (The team shall generate a summary report weekly.) Tj' }] }, 'contract.pdf');
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
  for (const cap of graph.capabilities) {
    for (const prov of cap.provenance) {
      assert.equal(prov.documentPath, 'contract.pdf');
      assert.ok(prov.pages.length > 0);
    }
  }
});

test('integration: a capability required-knowledge-node links to a Stage 4 knowledge node it mentions', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Send the invoice to Acme Corp within ten days.) Tj' }] });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
  const cap = graph.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.ok(cap!.requiredKnowledgeNodeIds.length > 0);
});

test('integration: rule-based-only extraction (no aiCore) still produces a correct graph', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: '/F1 20 Tf 72 750 Td (Contract Review) Tj /F1 12 Tf 0 -40 Td (General provisions apply.) Tj' }] });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
  assert.ok(graph.capabilities.some((c) => c.category === 'analysis'));
});

test('integration: with an AI extractor available, AI-derived capabilities appear alongside rule-based ones', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Send a confirmation email to the client.) Tj' }] });
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Escalate Unresolved Issues', description: 'Escalates issues that remain unresolved after a set period.', evidenceExcerptOffsets: [], confidence: 0.9 }] };
  const provider = new ScriptableTestProvider('anthropic', experienceDoc.units.map(() => ({ kind: 'success' as const, response: jsonResponse(output) })));
  const aiCore = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph, { aiCore });
  assert.ok(graph.capabilities.some((c) => c.canonicalName === 'Escalate Unresolved Issues'));
  assert.ok(graph.capabilities.some((c) => c.category === 'communication')); // rule-based candidate still present too
});

test('integration: an unreachable AI provider degrades gracefully, never throwing', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Send a notice promptly.) Tj' }] });
  const aiCore = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph, { aiCore });
  assert.ok(graph.capabilities.length > 0);
});

test('determinism: compiling the same document twice produces a byte-for-byte identical CapabilityGraph', async () => {
  const spec: TestPdfSpec = {
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Notifications) Tj ' +
          '/F1 12 Tf 0 -40 Td (Acme Corp shall send a confirmation email upon completion.) Tj',
      },
    ],
  };
  const pipelineA = await pipelineFromPdf(spec);
  const pipelineB = await pipelineFromPdf(spec);
  const graphA = await extractCapabilityGraph(pipelineA.experienceDoc, pipelineA.knowledgeGraph);
  const graphB = await extractCapabilityGraph(pipelineB.experienceDoc, pipelineB.knowledgeGraph);
  assert.deepEqual(graphA, graphB);
  assert.equal(hashCapabilityGraph(graphA), hashCapabilityGraph(graphB));
});

test('a document with no units produces an empty but valid graph', async () => {
  const { experienceDoc, knowledgeGraph } = await pipelineFromPdf({ pages: [{ contentOps: 'q 1 0 0 RG 0 0 100 100 re S Q' }] });
  const graph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
  assert.deepEqual(graph.capabilities, []);
  assert.deepEqual(graph.relationships, []);
});
