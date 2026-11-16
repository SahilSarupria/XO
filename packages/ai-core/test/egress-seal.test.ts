// UW-14b — once the instance seals the template registry, text arriving while serving can never become a template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineResponseSchema, defineTemplate, sealTemplates, templatesSealed } from '../src/egress/index.js';

const BEFORE = defineTemplate('test/seal-before', 'Defined while the module loads.');

test('templates defined at load time work; after sealing no template or response schema can be added', () => {
  assert.equal(BEFORE.text, 'Defined while the module loads.');
  assert.equal(templatesSealed(), false);
  sealTemplates();
  assert.equal(templatesSealed(), true);
  assert.throws(() => defineTemplate('test/seal-after', 'Asha Rao asked for this'), /templates are sealed/);
  assert.throws(() => defineResponseSchema('test/seal-schema', {}), /templates are sealed/);
});
