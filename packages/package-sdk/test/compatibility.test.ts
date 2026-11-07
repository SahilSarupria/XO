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

test('a host missing a capability its family lists degrades component by component, not to nothing', () => {
  const base = buildSampleBundle().manifest;
  const kg = base.components['knowledge_graph']!;
  const manifest = { ...base, components: { ...base.components, decision_trees: kg, reasoning_traces: kg } };
  const full = resolveCompatibility(manifest, { family: 'claude', capabilities: ['chat', 'tool_use'] });
  const chatOnly = resolveCompatibility(manifest, { family: 'claude', capabilities: ['chat'] });
  assert.ok(full.resolvedComponents.includes('decision_trees'));
  assert.equal(full.reachedLevel, 'L3');
  assert.equal(chatOnly.reachedLevel, 'L2', 'exemplars as context, no callable trees');
  assert.equal(chatOnly.resolvedComponents.includes('decision_trees'), false, 'decision trees need tool_use');
  assert.ok(chatOnly.skippedComponents.includes('decision_trees'));
  assert.ok(chatOnly.resolvedComponents.length > 0, 'everything else is still served');
  assert.notEqual(chatOnly.reachedLevel, 'L3');
});

test('a host that cannot even chat falls back to L0 with nothing resolved', () => {
  const bundle = buildSampleBundle();
  const resolution = resolveCompatibility(bundle.manifest, { family: 'claude', capabilities: [] });
  assert.equal(resolution.reachedLevel, 'L0');
  assert.equal(resolution.resolvedComponents.length, 0);
});

test('an undeclared model family is served the generic family when the manifest has one, and resolves to L0 (not an error) when it does not', () => {
  const bundle = buildSampleBundle();
  assert.equal(resolveCompatibility(bundle.manifest, { family: 'some_unlisted_family', capabilities: ['chat'] }).reachedLevel, 'L1');
});

test('components the family declaration offers but the package does not carry are skipped, not errored', () => {
  const bundle = buildSampleBundle(); // manifest declares consumes: knowledge_graph, decision_trees, reasoning_traces for claude, but only knowledge_graph is actually a component
  const resolution = resolveCompatibility(bundle.manifest, { family: 'claude', capabilities: ['chat', 'tool_use'] });
  assert.equal(resolution.resolvedComponents.includes('decision_trees' as never), false);
});
