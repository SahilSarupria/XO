import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer } from '@xo/ai-core';
import { AMBIGUITY_CONFIDENCE_THRESHOLD, createDefaultBoundaryResolver, RuleBasedOnlyResolver } from '../../src/semantic/boundary-resolver.js';

test('RuleBasedOnlyResolver returns the rule-based classification unchanged', async () => {
  const resolver = new RuleBasedOnlyResolver();
  const result = await resolver.resolve({ ruleBasedType: 'general', ruleBasedConfidence: 0.5, text: 'some ambiguous text' });
  assert.equal(result.semanticType, 'general');
  assert.equal(result.confidence, 0.5);
  assert.equal(result.resolvedBy, 'rule');
});

test('createDefaultBoundaryResolver() with no arguments returns a working resolver', async () => {
  const resolver = createDefaultBoundaryResolver();
  const result = await resolver.resolve({ ruleBasedType: 'clause', ruleBasedConfidence: 0.4, text: 'x' });
  assert.equal(result.semanticType, 'clause');
});

test('createDefaultBoundaryResolver() accepts a real AiCapabilityLayer instance (integration seam, not yet exercised)', async () => {
  const aiCore = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const resolver = createDefaultBoundaryResolver(aiCore);
  const result = await resolver.resolve({ ruleBasedType: 'obligation', ruleBasedConfidence: 0.55, text: 'x' });
  assert.equal(result.semanticType, 'obligation'); // still rule-based today — see boundary-resolver.ts's doc comment
});

test('AMBIGUITY_CONFIDENCE_THRESHOLD is a sensible probability value', () => {
  assert.ok(AMBIGUITY_CONFIDENCE_THRESHOLD > 0 && AMBIGUITY_CONFIDENCE_THRESHOLD < 1);
});
