import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptRegistry, createDefaultPromptRegistry } from '../../src/prompt/prompt-registry.js';
import { definePromptTemplate } from '../../src/prompt/prompt-template.js';

test('registers and resolves the default (first-registered) version', () => {
  const registry = new PromptRegistry();
  const v1 = definePromptTemplate<{}>('extractEntities', 'v1', () => [{ role: 'user', content: 'v1' }]);
  registry.register(v1);
  const resolved = registry.resolve('extractEntities');
  assert.equal(resolved.version, 'v1');
});

test('an explicit isDefault: true registration overrides the default', () => {
  const registry = new PromptRegistry();
  const v1 = definePromptTemplate<{}>('extractEntities', 'v1', () => []);
  const v2 = definePromptTemplate<{}>('extractEntities', 'v2', () => []);
  registry.register(v1);
  registry.register(v2, { isDefault: true });
  assert.equal(registry.resolve('extractEntities').version, 'v2');
});

test('resolving an explicit version pins to that version regardless of default', () => {
  const registry = new PromptRegistry();
  registry.register(definePromptTemplate<{}>('extractEntities', 'v1', () => []));
  registry.register(definePromptTemplate<{}>('extractEntities', 'v2', () => []), { isDefault: true });
  assert.equal(registry.resolve('extractEntities', 'v1').version, 'v1');
});

test('resolving an unregistered capability throws AI_PROMPT_NOT_FOUND', () => {
  const registry = new PromptRegistry();
  assert.throws(() => registry.resolve('extractEntities'), /No default prompt version registered/);
});

test('resolving an unregistered explicit version throws AI_PROMPT_NOT_FOUND', () => {
  const registry = new PromptRegistry();
  registry.register(definePromptTemplate<{}>('extractEntities', 'v1', () => []));
  assert.throws(() => registry.resolve('extractEntities', 'v99'), /No prompt registered/);
});

test('createDefaultPromptRegistry has a default for every capability', () => {
  const registry = createDefaultPromptRegistry();
  for (const capability of ['extractEntities', 'extractKnowledge', 'extractReasoning', 'extractCapabilities', 'extractDecisionGraph', 'extractConstraints'] as const) {
    assert.doesNotThrow(() => registry.resolve(capability));
  }
});

test('rendered messages include the excerpt text', () => {
  const registry = createDefaultPromptRegistry();
  const template = registry.resolve<{}>('extractEntities');
  const messages = template.render({}, 'MY EXCERPT TEXT');
  assert.ok(messages.some((m) => m.content.includes('MY EXCERPT TEXT')));
});
