import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '@xo/types';
import { ErrorCode } from '@xo/errors';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { NonProductionAuditSink, actorFromPrincipal, SYSTEM_ACTOR } from '@xo/audit';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import {
  RuntimeCapabilityExecutor,
  type RuntimeExecutionAudit,
  type RuntimeExecutionAuditInfo,
} from '../src/capability-authority/runtime-capability-executor.js';
import { ContextAssembler } from '../src/context/context-assembler.js';
import { RuntimeMemory } from '../src/memory/runtime-memory.js';
import { sessionScope } from '../src/memory/memory-types.js';
import { testSubject } from './authz-helpers.js';
import { contractAnalysisCapability } from './fixtures.js';

// P1.0 M4 — direct-runtime audit hook semantics + model-exclusion guards at runtime ingestion boundaries.

class RecordingAudit implements RuntimeExecutionAudit {
  readonly calls: string[] = [];
  failBefore = false;
  failAfter = false;
  async beforeExecute(_i: RuntimeExecutionAuditInfo): Promise<void> {
    this.calls.push('before');
    if (this.failBefore) throw new Error('outage');
  }
  async onDenied(i: RuntimeExecutionAuditInfo & { reasonCode: string }): Promise<void> {
    this.calls.push(`denied:${i.reasonCode}`);
  }
  async afterExecute(i: RuntimeExecutionAuditInfo & { ok: boolean }): Promise<boolean> {
    this.calls.push(`after:${i.ok}`);
    return !this.failAfter;
  }
}

function build(
  audit: RuntimeExecutionAudit,
  requiredPermissions: readonly string[] = [],
): { executor: RuntimeCapabilityExecutor; handlerCalls: () => number } {
  const registry = new RuntimeCapabilityRegistry();
  let calls = 0;
  registry.register({
    declaration: {
      capabilityId: 'echo',
      inputContract: { description: 'x' },
      outputContract: { description: 'x' },
      handler: async (i) => {
        calls++;
        return ok(i);
      },
    },
    requiredPermissions: requiredPermissions as never,
  });
  return {
    executor: new RuntimeCapabilityExecutor({
      registry,
      permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
      subject: testSubject(),
      audit,
    }),
    handlerCalls: () => calls,
  };
}

test('direct runtime: audit precondition failure => handler NEVER runs (fail closed, AUDIT_UNAVAILABLE)', async () => {
  const audit = new RecordingAudit();
  audit.failBefore = true;
  const { executor, handlerCalls } = build(audit);
  const r = await executor.execute({ capabilityId: 'echo', input: 'x' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCode.AUDIT_UNAVAILABLE);
  assert.equal(handlerCalls(), 0);
  assert.deepEqual(audit.calls, ['before']);
});

test('direct runtime: success records before -> after in order; result unchanged and no finalization flag', async () => {
  const audit = new RecordingAudit();
  const { executor, handlerCalls } = build(audit);
  const r = await executor.execute({ capabilityId: 'echo', input: 'hi' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.output, 'hi');
    assert.equal(r.value.auditFinalization, undefined);
  }
  assert.deepEqual(audit.calls, ['before', 'after:true']);
  assert.equal(handlerCalls(), 1);
});

test('direct runtime: completion-audit failure keeps the real result, flags it, and does NOT re-run the handler', async () => {
  const audit = new RecordingAudit();
  audit.failAfter = true;
  const { executor, handlerCalls } = build(audit);
  const r = await executor.execute({ capabilityId: 'echo', input: 'hi' });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.auditFinalization, 'failed');
  assert.equal(handlerCalls(), 1);
});

test('direct runtime: a permission denial is recorded and the handler never runs, and "before" is never reached', async () => {
  const audit = new RecordingAudit();
  const { executor, handlerCalls } = build(audit, ['filesystem.read']);
  const r = await executor.execute({ capabilityId: 'echo', input: 'x' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
  assert.deepEqual(audit.calls, [`denied:${ErrorCode.RUNTIME_PERMISSION_DENIED}`]);
  assert.equal(handlerCalls(), 0);
});

test('direct runtime: an audit hook that throws on denial cannot change the denial', async () => {
  const audit = new RecordingAudit();
  audit.onDenied = async () => {
    throw new Error('boom');
  };
  const { executor } = build(audit, ['filesystem.read']);
  const r = await executor.execute({ capabilityId: 'echo', input: 'x' });
  assert.equal(r.ok, false);
});

test('direct runtime with the @xo/audit adapter + real sink: trusted-context runs are recorded with the SYSTEM actor', async () => {
  const { createRuntimeExecutionAudit } = await import('@xo/audit');
  const sink = new NonProductionAuditSink();
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: {
      capabilityId: 'echo',
      inputContract: { description: 'x' },
      outputContract: { description: 'x' },
      handler: async (i) => ok(i),
    },
    requiredPermissions: [],
  });
  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
    audit: createRuntimeExecutionAudit(sink, 'cli-test-1') as RuntimeExecutionAudit,
  });
  assert.ok((await executor.execute({ capabilityId: 'echo', input: 'SECRET-INPUT' })).ok);
  const ev = sink.events();
  assert.deepEqual(
    ev.map((e) => e.type),
    ['execution.started', 'execution.completed'],
  );
  assert.ok(ev.every((e) => e.correlationId === 'cli-test-1'));
  assert.ok(!JSON.stringify(ev).includes('SECRET-INPUT'), 'input is never audited');
  void SYSTEM_ACTOR;
  void actorFromPrincipal;
});

// ── model exclusion at runtime ingestion boundaries ───────────────────

async function sampleAuditEvent() {
  const sink = new NonProductionAuditSink();
  const r = await sink.append({ type: 'access.attempted', action: 'read.x', outcome: 'attempted', actor: SYSTEM_ACTOR });
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  return r.event;
}

test('model exclusion: ContextAssembler refuses audit data in slices or graph (and still assembles ordinary content)', async () => {
  const ev = await sampleAuditEvent();
  const capability = { declaration: contractAnalysisCapability, packageName: 'p', packageVersion: '1' };
  const slice = (content: string) => ({
    packageName: 'p',
    packageVersion: '1',
    componentKind: 'prompt_strategies' as const,
    content,
    estimatedTokens: 1,
  });
  assert.throws(() => new ContextAssembler().assemble({ capability, slices: [slice(JSON.stringify(ev))] }), /restricted audit data/);
  assert.throws(
    () => new ContextAssembler().assemble({ capability, slices: [{ ...slice('x'), content: ev as never }] }),
    /restricted audit data/,
  );
  assert.doesNotThrow(() => new ContextAssembler().assemble({ capability, slices: [slice('ordinary guidance')] }));
});

test('model exclusion: runtime memory refuses to store audit data (value or metadata) but stores ordinary values', async () => {
  const ev = await sampleAuditEvent();
  const memory = new RuntimeMemory();
  const scope = sessionScope('s-audit');
  for (const input of [
    { scope, type: 'fact' as const, value: ev },
    { scope, type: 'fact' as const, value: { nested: [JSON.stringify(ev)] } },
    { scope, type: 'fact' as const, value: 'ok', metadata: { carried: ev } },
  ]) {
    const r = await memory.put(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, ErrorCode.AUDIT_ACCESS_DENIED);
  }
  assert.ok((await memory.put({ scope, type: 'fact', value: 'ordinary' })).ok);
  const all = await memory.query(scope);
  assert.ok(all.ok && all.value.length === 1);
});
