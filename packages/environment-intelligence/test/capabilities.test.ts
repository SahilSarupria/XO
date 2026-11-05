import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy, parsePermissionId, type PolicyRule } from '@xo/permissions';
import {
  InMemoryAuditRecorder,
  PermissionManagerAuthorization,
  queryCapabilities,
  type AuthorizationPort,
  type ConnectorContext,
} from '../src/index.js';
import { TEST_PRINCIPAL, authenticated } from './helpers.js';
import { TerminalRefusingAudit } from './support/agent-env.js';

const rule = (permission: string, principalId: string): PolicyRule => {
  const p = parsePermissionId(permission);
  if (!p.ok) throw new Error(permission);
  return { id: `${principalId}-${permission}`, effect: 'ALLOW', match: { permission: p.value.id, principalId } };
};
const gate = (rules: PolicyRule[]): AuthorizationPort =>
  new PermissionManagerAuthorization(new PermissionManager({ policy: new RuleBasedPolicy(rules) }));
const ctx = (
  authorization: AuthorizationPort,
  audit: ConnectorContext['audit'],
  principal: ConnectorContext['principal'] = TEST_PRINCIPAL,
): ConnectorContext => ({
  clock: { now: () => new Date('2026-11-02T00:00:00Z') },
  authorization,
  principal,
  ...(audit !== undefined ? { audit } : {}),
});
const all = (id: string): PolicyRule[] => [rule('data.read', id), rule('data.write', id)];

test('every allowed probe is audited with a write-ahead attempt and a completion; the answer follows the gate', async () => {
  const audit = new InMemoryAuditRecorder();
  const r = await queryCapabilities(ctx(gate(all(TEST_PRINCIPAL.id)), audit));
  assert.ok(r.ok);
  assert.deepEqual(r.value, { viewSources: true, manageSources: true, readKnowledge: true, reviewKnowledge: true });
  const ev = audit.events();
  assert.equal(ev.length, 8);
  assert.ok(ev.every((e) => e.operation === 'query_capabilities'));
  for (let i = 0; i < 8; i += 2) {
    assert.equal(ev[i]?.phase, 'attempt');
    assert.equal(ev[i + 1]?.phase, 'terminal');
    assert.equal(ev[i + 1]?.outcome, 'completed');
  }
  assert.deepEqual(audit.openAttempts(), [], 'no attempt is left open');
});

test('read-only grants: viewing and reading yes, managing and reviewing no; denials are audited as denied', async () => {
  const audit = new InMemoryAuditRecorder();
  const r = await queryCapabilities(ctx(gate([rule('data.read', TEST_PRINCIPAL.id)]), audit));
  assert.ok(r.ok);
  assert.deepEqual(r.value, { viewSources: true, manageSources: false, readKnowledge: true, reviewKnowledge: false });
  const denied = audit.events().filter((e) => e.outcome === 'denied');
  assert.equal(denied.length, 2);
  assert.ok(denied.every((e) => e.phase === 'standalone' && e.operation === 'query_capabilities'));
});

test('no grants: nothing is allowed', async () => {
  const r = await queryCapabilities(ctx(gate([]), new InMemoryAuditRecorder()));
  assert.ok(r.ok);
  assert.deepEqual(r.value, { viewSources: false, manageSources: false, readKnowledge: false, reviewKnowledge: false });
});

test("a grant for another principal is not this principal's capability", async () => {
  const r = await queryCapabilities(ctx(gate(all('someone-else')), new InMemoryAuditRecorder()));
  assert.ok(r.ok && !r.value.viewSources && !r.value.manageSources);
});

test('fail closed: no audit recorder, or an unaccepted attempt or completion, yields no answer', async () => {
  const g = gate(all(TEST_PRINCIPAL.id));
  const none = await queryCapabilities(ctx(g, undefined));
  assert.ok(!none.ok && none.error.code === 'EI_AUDIT_UNAVAILABLE');
  const noTerminal = await queryCapabilities(ctx(g, new TerminalRefusingAudit(new InMemoryAuditRecorder())));
  assert.ok(!noTerminal.ok && noTerminal.error.code === 'EI_AUDIT_UNAVAILABLE');
});

test('unauthenticated callers are refused before the gate or the audit is touched', async () => {
  let asked = 0;
  const port: AuthorizationPort = { decide: async () => ((asked += 1), { effect: 'allow', reason: 'x' }) };
  const audit = new InMemoryAuditRecorder();
  const r = await queryCapabilities(ctx(port, audit, { kind: 'human', id: 'x' } as never));
  assert.ok(!r.ok);
  assert.equal(asked, 0);
  assert.equal(audit.events().length, 0);
  void authenticated;
});

test('an untrusted port that merely says "allow" does not grant a capability', async () => {
  const forged: AuthorizationPort = { decide: async () => ({ effect: 'allow', reason: 'trust me' }) };
  const r = await queryCapabilities(ctx(forged, new InMemoryAuditRecorder()));
  assert.ok(r.ok);
  assert.deepEqual(r.value, { viewSources: false, manageSources: false, readKnowledge: false, reviewKnowledge: false });
});
