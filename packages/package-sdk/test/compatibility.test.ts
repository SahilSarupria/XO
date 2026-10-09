import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompatibility } from '../src/manifest/compatibility.js';
import { buildSampleBundle } from './fixtures.js';

test('a host with full capabilities reaches the highest level the manifest offers that family', () => {
  const bundle = buildSampleBundle();
  const resolution = resolveCompatibility(bundle.manifest, { family: 'claude', capabilities: ['chat', 'tool_use'] });
  assert.equal(resolution.reachedLevel, 'L1'); // only knowledge_graph is actually present among safety_rules/benchmark_suite/knowledge_graph
  assert.ok(resolution.resolvedComponents.includes('knowledge_graph'));
});

test('a host missing a required capability falls back to L0 with nothing resolved', () => {
  const bundle = buildSampleBundle();
  const resolution = resolveCompatibility(bundle.manifest, { family: 'claude', capabilities: ['chat'] }); // missing tool_use
  assert.equal(resolution.reachedLevel, 'L0');
  assert.equal(resolution.resolvedComponents.length, 0);
});

test('an undeclared model family resolves to L0, not an error', () => {
  const bundle = buildSampleBundle();
  const resolution = resolveCompatibility(bundle.manifest, { family: 'some_unlisted_family', capabilities: ['chat'] });
  assert.equal(resolution.reachedLevel, 'L0');
  assert.equal(resolution.resolvedComponents.length, 0);
});

test('components the family declaration offers but the package does not carry are skipped, not errored', () => {
  const bundle = buildSampleBundle(); // manifest declares consumes: knowledge_graph, decision_trees, reasoning_traces for claude, but only knowledge_graph is actually a component
  const resolution = resolveCompatibility(bundle.manifest, { family: 'claude', capabilities: ['chat', 'tool_use'] });
  assert.equal(resolution.resolvedComponents.includes('decision_trees' as never), false);
});
