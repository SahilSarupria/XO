import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { ErrorCode } from '@xo/errors';
import { InMemoryDurableMemoryStore } from '../src/memory/in-memory-durable-memory-store.js';
import { createPermissionManagerMemoryGate } from '../src/memory/memory-permission-manager-gate.js';
import { RuntimeMemory } from '../src/memory/runtime-memory.js';
import { executionScope, sessionScope, workflowScope, runtimeScope } from '../src/memory/memory-types.js';

const now = () => new Date('2026-01-01T00:00:00.000Z');

function freshMemory(): RuntimeMemory {
  return new RuntimeMemory(new InMemoryDurableMemoryStore(now), { now });
}

test('RuntimeMemory.put with a key upserts: same (scope, key) replaces value and preserves createdAt', async () => {
  const memory = freshMemory();
  const scope = executionScope('exec-1');

  const first = await memory.put({ scope, type: 'preference', key: 'lang', value: 'en' });
  assert.equal(first.ok, true);
  const firstCreatedAt = first.ok ? first.value.data.createdAt : undefined;

  const second = await memory.put({ scope, type: 'preference', key: 'lang', value: 'fr' });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.value.data.value, 'fr');
    assert.equal(second.value.data.id, first.ok ? first.value.data.id : undefined, 'same key must derive the same id');
    assert.equal(second.value.data.createdAt, firstCreatedAt, 'createdAt is preserved across an upsert');
  }

  const listed = await memory.query(scope);
  assert.equal(listed.ok && listed.value.length, 1, 'upsert must not create a second entry');
});

test('RuntimeMemory.put without a key creates a distinct entry every call (unique event instances)', async () => {
  const memory = freshMemory();
  const scope = executionScope('exec-events');
  await memory.put({ scope, type: 'result', value: 'call-1' });
  await memory.put({ scope, type: 'result', value: 'call-2' });
  const listed = await memory.query(scope);
  assert.equal(listed.ok && listed.value.length, 2);
});

test('RuntimeMemory.forScope binds a scope and cannot be pointed at a different one', async () => {
  const memory = freshMemory();
  const scoped = memory.forScope(sessionScope('sess-bound'));
  await scoped.put({ type: 'fact', key: 'k', value: 'v' });
  const listedViaFacade = await scoped.query();
  assert.equal(listedViaFacade.ok && listedViaFacade.value.length, 1);

  // Reading the same key from a *different* scope via the top-level API finds nothing.
  const otherScopeRead = await memory.query(sessionScope('sess-other'));
  assert.deepEqual(otherScopeRead.ok && otherScopeRead.value, []);
});

test('RuntimeMemory.queryAcrossScopes merges results from multiple explicit scopes, sorted by createdAt', async () => {
  const memory = freshMemory();
  const execScope = executionScope('exec-2');
  const sessScope = sessionScope('sess-2');

  await memory.put({ scope: sessScope, type: 'preference', key: 'theme', value: 'dark' });
  await memory.put({ scope: execScope, type: 'result', value: 'exec-local' });

  const merged = await memory.queryAcrossScopes([execScope, sessScope]);
  assert.equal(merged.ok, true);
  assert.equal(merged.ok && merged.value.length, 2);

  // A plain single-scope query must NOT see the other scope's data.
  const execOnly = await memory.query(execScope);
  assert.equal(execOnly.ok && execOnly.value.length, 1);
});

test('RuntimeMemory.queryAcrossScopes respects a global limit across the merged set', async () => {
  const memory = freshMemory();
  const a = executionScope('exec-a');
  const b = executionScope('exec-b');
  await memory.put({ scope: a, type: 'fact', value: 1 });
  await memory.put({ scope: b, type: 'fact', value: 2 });
  await memory.put({ scope: b, type: 'fact', value: 3 });

  const merged = await memory.queryAcrossScopes([a, b], { limit: 2 });
  assert.equal(merged.ok && merged.value.length, 2);
});

test('RuntimeMemory: TTL — an entry written with ttlSeconds is retrievable before expiry', async () => {
  const memory = freshMemory();
  const scope = runtimeScope();
  const written = await memory.put({ scope, type: 'context', value: 'short-lived', ttlSeconds: 3600 });
  assert.equal(written.ok, true);
  const got = written.ok ? await memory.get(scope, written.value.data.id) : undefined;
  assert.ok(got?.ok && got.value);
});

test('RuntimeMemory: workflow scope is isolated from execution scope even for the same scopeId string', async () => {
  const memory = freshMemory();
  const id = 'shared-instance-id';
  await memory.put({ scope: workflowScope(id), type: 'context', key: 'k', value: 'workflow-value' });
  await memory.put({ scope: executionScope(id), type: 'context', key: 'k', value: 'execution-value' });

  const wf = await memory.query(workflowScope(id));
  const exec = await memory.query(executionScope(id));
  assert.equal(wf.ok && wf.value[0]?.data.value, 'workflow-value');
  assert.equal(exec.ok && exec.value[0]?.data.value, 'execution-value');
});

// --- Permission integration -----------------------------------------------

test('RuntimeMemory: default (no permissionGate) allows every operation', async () => {
  const memory = freshMemory();
  const scope = executionScope('exec-default-allow');
  const result = await memory.put({ scope, type: 'fact', value: 'x' }, { packageId: 'pkg:test/anything' });
  assert.equal(result.ok, true);
});

test('RuntimeMemory: a denying permission gate rejects put with RUNTIME_PERMISSION_DENIED, and the entry is never written', async () => {
  const policy = new RuleBasedPolicy([{ id: 'deny-memory-write', effect: 'DENY', match: { permission: 'runtime.memory-write' } }], 'ALLOW');
  const manager = new PermissionManager({ policy });
  const gate = createPermissionManagerMemoryGate({ manager });
  const memory = new RuntimeMemory(new InMemoryDurableMemoryStore(now), { now, permissionGate: gate });

  const scope = executionScope('exec-denied');
  const denied = await memory.put({ scope, type: 'fact', value: 'nope' }, { packageId: 'pkg:test/writer' });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
  }

  // Reads (not denied by this policy) confirm nothing was actually persisted.
  const listed = await memory.query(scope, undefined, { packageId: 'pkg:test/writer' });
  assert.deepEqual(listed.ok && listed.value, []);
});

test('RuntimeMemory: permission grant scoped to one resource (memory:execution:X) does not extend to a different scope', async () => {
  const grantedScope = executionScope('exec-granted');
  const otherScope = executionScope('exec-not-granted');
  const policy = new RuleBasedPolicy(
    [{ id: 'allow-granted-scope', effect: 'ALLOW', match: { permission: 'runtime.memory-write', scope: { kind: 'resource', resource: `memory:execution:${grantedScope.scopeId}` } } }],
    'DENY',
  );
  const manager = new PermissionManager({ policy });
  const gate = createPermissionManagerMemoryGate({ manager });
  const memory = new RuntimeMemory(new InMemoryDurableMemoryStore(now), { now, permissionGate: gate });

  const allowed = await memory.put({ scope: grantedScope, type: 'fact', value: 'ok' }, { packageId: 'pkg:test/scoped' });
  assert.equal(allowed.ok, true);

  const denied = await memory.put({ scope: otherScope, type: 'fact', value: 'nope' }, { packageId: 'pkg:test/scoped' });
  assert.equal(denied.ok, false);
});

test('RuntimeMemory.queryAcrossScopes: a scope denied "share" is silently omitted from the merged result rather than failing the whole call', async () => {
  const readableScope = sessionScope('sess-shareable');
  const blockedScope = executionScope('exec-blocked-share');
  const policy = new RuleBasedPolicy(
    [{ id: 'deny-share', effect: 'DENY', match: { permission: 'runtime.memory-share', scope: { kind: 'resource', resource: `memory:execution:${blockedScope.scopeId}` } } }],
    'ALLOW',
  );
  const manager = new PermissionManager({ policy });
  const gate = createPermissionManagerMemoryGate({ manager });
  const memory = new RuntimeMemory(new InMemoryDurableMemoryStore(now), { now, permissionGate: gate });

  await memory.put({ scope: readableScope, type: 'fact', value: 'from-session' }, { packageId: 'pkg:test/x' });
  await memory.put({ scope: blockedScope, type: 'fact', value: 'from-execution' }, { packageId: 'pkg:test/x' });

  const merged = await memory.queryAcrossScopes([readableScope, blockedScope], undefined, { packageId: 'pkg:test/x' });
  assert.equal(merged.ok, true);
  assert.equal(merged.ok && merged.value.length, 1);
  assert.equal(merged.ok && merged.value[0]?.data.value, 'from-session');
});
