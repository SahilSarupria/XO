import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session/session-manager.js';
import { withPlan } from '../src/session/execution-session.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';

function request(id = 'req_1'): ExecutionRequest {
  return {
    requestId: RequestId(id),
    capabilityId: 'contract_analysis',
    environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: '2026-01-01T00:00:00.000Z' },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('create() stores and returns a new pending session', () => {
  const manager = new SessionManager();
  const session = manager.create(request());
  assert.equal(session.status, 'pending');
  assert.equal(manager.get(session.sessionId), session);
});

test('get() on an unknown sessionId returns undefined', () => {
  const manager = new SessionManager();
  assert.equal(manager.get('nonexistent' as never), undefined);
});

test('update() overwrites the stored value for a session', () => {
  const manager = new SessionManager();
  const session = manager.create(request());
  const updated = withPlan(session, { planId: 'p1' as never, requestId: session.requestId, status: 'no_candidates', candidates: [], plannedAt: '2026-01-01T00:00:00.000Z' });
  manager.update(updated);
  assert.equal(manager.get(session.sessionId)?.status, 'plan_failed');
});

test('all() lists every stored session', () => {
  const manager = new SessionManager();
  manager.create(request('req_1'));
  manager.create(request('req_2'));
  assert.equal(manager.all().length, 2);
});

test('delete() removes a session and reports whether it existed', () => {
  const manager = new SessionManager();
  const session = manager.create(request());
  assert.equal(manager.delete(session.sessionId), true);
  assert.equal(manager.get(session.sessionId), undefined);
  assert.equal(manager.delete(session.sessionId), false);
});

test('size reflects the current number of stored sessions', () => {
  const manager = new SessionManager();
  manager.create(request('req_1'));
  manager.create(request('req_2'));
  assert.equal(manager.size, 2);
});
