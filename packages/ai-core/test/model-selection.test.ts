import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, type ModelSelectionPolicy } from '../src/model-selection.js';
import type { ProviderCapabilityDescriptor } from '../src/provider-types.js';

function descriptor(providerId: string, supportsStructuredOutput: boolean): ProviderCapabilityDescriptor {
  return { providerId, models: ['m1'], supportsStreaming: false, supportsStructuredOutput, supportsVision: false, maxContextTokens: 1000 };
}

test('returns candidates in providerOrder for a capability-specific rule', () => {
  const policy: ModelSelectionPolicy = {
    rules: [{ capability: 'extractEntities', providerOrder: ['anthropic', 'openai'], modelByProvider: { anthropic: 'claude-x', openai: 'gpt-x' } }],
  };
  const descriptors = new Map([
    ['anthropic', descriptor('anthropic', true)],
    ['openai', descriptor('openai', true)],
  ]);
  const candidates = selectCandidates(policy, 'extractEntities', new Set(['anthropic', 'openai']), descriptors, true);
  assert.deepEqual(candidates, [
    { providerId: 'anthropic', model: 'claude-x' },
    { providerId: 'openai', model: 'gpt-x' },
  ]);
});

test('falls back to a wildcard rule when no capability-specific rule exists', () => {
  const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'claude-x' } }] };
  const descriptors = new Map([['anthropic', descriptor('anthropic', true)]]);
  const candidates = selectCandidates(policy, 'extractConstraints', new Set(['anthropic']), descriptors, true);
  assert.equal(candidates.length, 1);
});

test('excludes a provider that is not registered', () => {
  const policy: ModelSelectionPolicy = {
    rules: [{ capability: 'extractEntities', providerOrder: ['anthropic', 'openai'], modelByProvider: { anthropic: 'claude-x', openai: 'gpt-x' } }],
  };
  const descriptors = new Map([['anthropic', descriptor('anthropic', true)]]);
  const candidates = selectCandidates(policy, 'extractEntities', new Set(['anthropic']), descriptors, true);
  assert.deepEqual(candidates.map((c) => c.providerId), ['anthropic']);
});

test('excludes a provider lacking structured output support when required', () => {
  const policy: ModelSelectionPolicy = {
    rules: [{ capability: 'extractEntities', providerOrder: ['ollama', 'anthropic'], modelByProvider: { ollama: 'llama3', anthropic: 'claude-x' } }],
  };
  const descriptors = new Map([
    ['ollama', descriptor('ollama', false)],
    ['anthropic', descriptor('anthropic', true)],
  ]);
  const candidates = selectCandidates(policy, 'extractEntities', new Set(['ollama', 'anthropic']), descriptors, true);
  assert.deepEqual(candidates.map((c) => c.providerId), ['anthropic']);
});

test('does not filter by structured output when it is not required', () => {
  const policy: ModelSelectionPolicy = { rules: [{ capability: 'extractEntities', providerOrder: ['ollama'], modelByProvider: { ollama: 'llama3' } }] };
  const descriptors = new Map([['ollama', descriptor('ollama', false)]]);
  const candidates = selectCandidates(policy, 'extractEntities', new Set(['ollama']), descriptors, false);
  assert.equal(candidates.length, 1);
});

test('returns an empty list when no rule matches at all', () => {
  const policy: ModelSelectionPolicy = { rules: [] };
  const candidates = selectCandidates(policy, 'extractEntities', new Set(), new Map(), true);
  assert.deepEqual(candidates, []);
});
