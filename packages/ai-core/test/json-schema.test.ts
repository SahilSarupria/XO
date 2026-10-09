import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema, type JsonSchema } from '../src/json-schema.js';

const schema: JsonSchema = {
  type: 'object',
  required: ['name', 'tags'],
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    kind: { type: 'string', enum: ['a', 'b'] },
  },
};

test('valid input produces no issues', () => {
  const issues = validateJsonSchema(schema, { name: 'x', tags: ['a', 'b'] });
  assert.deepEqual(issues, []);
});

test('flags a missing required property', () => {
  const issues = validateJsonSchema(schema, { tags: [] });
  assert.ok(issues.some((i) => i.path === '$.name'));
});

test('flags a wrong type for a property', () => {
  const issues = validateJsonSchema(schema, { name: 'x', tags: [], age: 'not a number' });
  assert.ok(issues.some((i) => i.path === '$.age'));
});

test('flags an array item of the wrong type', () => {
  const issues = validateJsonSchema(schema, { name: 'x', tags: [1, 2] });
  assert.ok(issues.some((i) => i.path === '$.tags[0]'));
});

test('flags a value outside an enum', () => {
  const issues = validateJsonSchema(schema, { name: 'x', tags: [], kind: 'c' });
  assert.ok(issues.some((i) => i.path === '$.kind'));
});

test('flags a non-object at the top level', () => {
  const issues = validateJsonSchema(schema, 'not an object');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, '$');
});

test('ignores properties not declared in the schema', () => {
  const issues = validateJsonSchema(schema, { name: 'x', tags: [], extra: 'field' });
  assert.deepEqual(issues, []);
});
