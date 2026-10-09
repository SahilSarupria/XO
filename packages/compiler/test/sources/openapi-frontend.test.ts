import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenApiSourceFrontend } from '../../src/sources/openapi-frontend.js';

const frontend = new OpenApiSourceFrontend();

function paragraphFields(result: ReturnType<OpenApiSourceFrontend['ingest']>) {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.error)}`);
  if (result.value.content.kind !== 'document') throw new Error('expected document content');
  const map = new Map<string, unknown>();
  for (const section of result.value.content.parsed.root.subsections) {
    for (const block of section.blocks) {
      if (block.kind === 'paragraph' && block.structuredField) map.set(block.structuredField.fieldName, block.structuredField.rawValue);
    }
  }
  return map;
}

const MINIMAL_DOC = {
  openapi: '3.0.0',
  paths: {
    '/brokerage/calculate': {
      post: {
        operationId: 'calculate_brokerage',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { premium: { type: 'number' }, rate: { type: 'number' } } } } } },
        responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { brokerage: { type: 'number' } } } } } } },
      },
    },
  },
};

test('recognizes an OpenAPI operation and extracts request/response schema properties as operation:input/output fields', () => {
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(MINIMAL_DOC), sourcePath: 'op.json' });
  const fields = paragraphFields(result);
  assert.equal(fields.get('operation:name'), 'calculate_brokerage');
  assert.equal(fields.get('operation:input:premium'), 'number');
  assert.equal(fields.get('operation:input:rate'), 'number');
  assert.equal(fields.get('operation:output:brokerage'), 'number');
});

test('an "x-requires" vendor extension becomes independent structural evidence, same as structured JSON\'s "requires"', () => {
  const doc = structuredClone(MINIMAL_DOC) as any;
  doc.paths['/brokerage/calculate'].post['x-requires'] = ['some_other_operation'];
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(doc), sourcePath: 'op.json' });
  const fields = paragraphFields(result);
  assert.ok([...fields.entries()].some(([k, v]) => k.startsWith('operation:requires:') && v === 'some_other_operation'));
});

// --- Refusal: only explicit operationId + explicit schema roles qualify ---

test('rejection: a path/method without an explicit operationId is skipped, never given an invented name', () => {
  const doc = { openapi: '3.0.0', paths: { '/x': { post: { requestBody: {}, responses: {} } } } };
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(doc), sourcePath: 'op.json' });
  assert.equal(result.ok, false);
});

test('rejection: an operation description does not become a schema property', () => {
  const doc = structuredClone(MINIMAL_DOC) as any;
  doc.paths['/brokerage/calculate'].post.description = 'Calculates the brokerage amount and returns a value';
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(doc), sourcePath: 'op.json' });
  const fields = paragraphFields(result);
  // Only the two declared input properties and the one declared output property — the free-text description contributes nothing.
  const inputFields = [...fields.keys()].filter((k) => k.startsWith('operation:input:'));
  const outputFields = [...fields.keys()].filter((k) => k.startsWith('operation:output:'));
  assert.deepEqual(new Set(inputFields), new Set(['operation:input:premium', 'operation:input:rate']));
  assert.deepEqual(new Set(outputFields), new Set(['operation:output:brokerage']));
});

test('rejection: a non-200 response schema (e.g. 400 error schema) is never treated as the operation\'s authoritative output', () => {
  const doc = structuredClone(MINIMAL_DOC) as any;
  doc.paths['/brokerage/calculate'].post.responses['400'] = { content: { 'application/json': { schema: { type: 'object', properties: { errorCode: { type: 'string' } } } } } };
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(doc), sourcePath: 'op.json' });
  const fields = paragraphFields(result);
  assert.equal(fields.has('operation:output:errorCode'), false);
});

test('rejection: an example value without a schema role does not become an output', () => {
  const doc = structuredClone(MINIMAL_DOC) as any;
  doc.paths['/brokerage/calculate'].post.responses['200'].content['application/json'].example = { totallyUnrelatedField: 42 };
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify(doc), sourcePath: 'op.json' });
  const fields = paragraphFields(result);
  assert.equal(fields.has('operation:output:totallyUnrelatedField'), false);
});

test('rejection: a document missing "openapi"/"paths" is refused outright, not partially interpreted', () => {
  const result = frontend.ingest({ kind: 'openapi', text: JSON.stringify({ hello: 'world' }), sourcePath: 'op.json' });
  assert.equal(result.ok, false);
});
