import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextAssembler } from '../src/context/context-assembler.js';
import { mergeKnowledgeGraphs } from '../src/retrieval/knowledge-graph-merge.js';
import type { RetrievedSlice } from '../src/retrieval/retrieved-slice.js';
import { contractAnalysisCapability } from './fixtures.js';

const capability = { declaration: contractAnalysisCapability, packageName: 'xo_lawyer', packageVersion: '1.0.0' };

function slice(kind: RetrievedSlice['componentKind'], content: string): RetrievedSlice {
  return { packageName: 'xo_lawyer', packageVersion: '1.0.0', componentKind: kind, content, estimatedTokens: 1 };
}

test('assemble() always opens with the capability framing', () => {
  const context = new ContextAssembler().assemble({ capability, slices: [] });
  assert.ok(context.systemPrompt.includes('Contract Analysis'));
  assert.ok(context.systemPrompt.includes(contractAnalysisCapability.description));
});

test('assemble() includes safety_rules and prompt_strategies content in the system prompt', () => {
  const context = new ContextAssembler().assemble({
    capability,
    slices: [slice('safety_rules', 'never do X'), slice('prompt_strategies', 'be concise')],
  });
  assert.ok(context.systemPrompt.includes('never do X'));
  assert.ok(context.systemPrompt.includes('be concise'));
});

test('assemble() includes the merged knowledge graph when one is supplied', () => {
  const merged = mergeKnowledgeGraphs([slice('knowledge_graph', JSON.stringify({ nodes: [{ id: 'n1' }], edges: [] }))]);
  const context = new ContextAssembler().assemble({ capability, slices: [], mergedKnowledgeGraph: merged });
  assert.ok(context.systemPrompt.includes('1 nodes'));
  assert.equal(context.mergedKnowledgeGraph, merged);
});

test('assemble() omits mergedKnowledgeGraph entirely when none is supplied', () => {
  const context = new ContextAssembler().assemble({ capability, slices: [] });
  assert.equal(context.mergedKnowledgeGraph, undefined);
});

test('assemble() no longer extracts tool schemas (the real @xo/ai-core ModelProvider layer has no tool-calling concept)', () => {
  const withToolLikeContent = new ContextAssembler().assemble({ capability, slices: [slice('prompt_strategies', JSON.stringify({ toolSchemas: [{ name: 'x', description: 'y', inputSchema: {} }] }))] });
  assert.equal('toolSchemas' in withToolLikeContent, false);
});

test('assemble() is deterministic: repeated calls with the same input produce the same output', () => {
  const slices = [slice('safety_rules', 'rule A'), slice('prompt_strategies', 'guidance B')];
  const first = new ContextAssembler().assemble({ capability, slices });
  const second = new ContextAssembler().assemble({ capability, slices });
  assert.equal(first.systemPrompt, second.systemPrompt);
});

test('an AssembledContext is frozen (immutable)', () => {
  const context = new ContextAssembler().assemble({ capability, slices: [] });
  assert.ok(Object.isFrozen(context));
});
