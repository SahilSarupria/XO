import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

// Domain-neutral API: widgets. Integration requirements come ONLY from declared operations and declared connectors.
const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Widgets', version: '1' },
  paths: {
    '/widgets': {
      get: { operationId: 'listWidgets', summary: 'List widgets', responses: { '200': { description: 'ok' } } },
      post: { operationId: 'createWidget', summary: 'Create a widget', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { sku: { type: 'string' } } } } } }, responses: { '201': { description: 'created' } } },
    },
  },
});
const OPENAPI = { kind: 'openapi' as const, text: SPEC, sourcePath: 'widgets.json' };
const PROSE = { kind: 'document' as const, text: '# Notes\nThe operator must email the owner when the widget count exceeds 5.\n', sourcePath: 'n.md' };

async function run(sources: unknown[], options = {}) {
  const r = await compileSources(sources as never, options);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value.executionReadiness!;
}
const find = (er: Awaited<ReturnType<typeof run>>, name: string) => er.capabilities.entries.find((e) => e.name === name)!;

test('a declared operation with no connector is external_integration_required, naming the missing binding', async () => {
  const er = await run([OPENAPI]);
  const e = find(er, 'createWidget');
  assert.equal(e.origin, 'declared-operation');
  assert.equal(e.executionState, 'external_integration_required');
  assert.deepEqual(e.requiredInputs, ['sku']);
  assert.ok(e.blockers.some((b) => /no connector/i.test(b)));
});

test('a declared connector covering the operation binds it (case-insensitively); others stay unbound', async () => {
  const er = await run([OPENAPI], { connectors: [{ id: 'widgets-api', operations: ['CREATEWIDGET'] }] });
  assert.equal(find(er, 'createWidget').executionState, 'bound_to_connector');
  assert.equal(find(er, 'createWidget').connectorId, 'widgets-api');
  assert.equal(find(er, 'listWidgets').executionState, 'external_integration_required');
});

test('capabilities discovered from prose never acquire an integration: not executable, and "email" does not invent a mail connector', async () => {
  const er = await run([PROSE]);
  assert.ok(er.capabilities.entries.length >= 1);
  for (const e of er.capabilities.entries) {
    assert.equal(e.origin, 'discovered');
    assert.equal(e.executionState, 'not_executable');
    assert.equal(e.connectorId, undefined);
  }
  assert.equal(JSON.stringify(er).toLowerCase().includes('smtp'), false);
});

test('a prose capability is NOT bound even if a connector happens to list the same words (binding is for declared operations only)', async () => {
  const er = await run([PROSE], { connectors: [{ id: 'mailer', operations: ['Email the owner', 'emailTheOwner'] }] });
  assert.equal(er.capabilities.entries.some((e) => e.executionState === 'bound_to_connector'), false);
});

test('a connector that declares an operation no source declares is reported, never silently accepted', async () => {
  const er = await run([OPENAPI], { connectors: [{ id: 'widgets-api', operations: ['createWidget', 'deleteEverything'] }] });
  assert.deepEqual(er.capabilities.unmatchedConnectorOperations, [{ connectorId: 'widgets-api', operation: 'deleteEverything' }]);
});

test('summary counts add up and compile emits a diagnostic when integrations are required', async () => {
  const r = await compileSources([OPENAPI], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const s = r.value.executionReadiness!.capabilities.summary;
  assert.equal(s.bound_to_connector + s.external_integration_required + s.not_executable, r.value.executionReadiness!.capabilities.entries.length);
  assert.ok(r.value.diagnostics.some((d) => d.code === 'execution-readiness/integration-required'));
});

test('rule-level readiness is unchanged by the capability analysis', async () => {
  const er = await run([PROSE]);
  assert.ok(er.summary.byExecutionState);
});
