import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '@xo/types';
import { ErrorCode } from '@xo/errors';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { buildContractLawyerBundle, mountBundle, withTempInstaller } from './fixtures.js';
import { CapabilityRegistry } from '../src/capability/capability-registry.js';
import { CapabilityNegotiator } from '../src/capability/capability-negotiator.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';

/**
 * These tests prove the exact invariant the Runtime capability authority
 * layer exists to preserve: a package's `knowledge_graph.json` can
 * contain data that *describes* a capability (the same shape the
 * compiler's Packager — `xoir-to-package.ts` — lowers a semantic
 * `capability` XOIR node into, per that module's own design: never
 * elevated into `manifest.capabilities`), and none of that data, on its
 * own, grants anything executable authority. Only an explicit call to
 * `RuntimeCapabilityRegistry.register()` does.
 */

/** A knowledge_graph.json payload shaped exactly like the Packager's real output for a `capability`-kind XOIR node — same field names, same id convention — but this is manually constructed test data standing in for that output, not the Packager itself (this package has no dependency on @xo/compiler, and shouldn't). */
function knowledgeGraphWithCapabilityLookingNode(capabilityId: string) {
  return {
    nodes: [
      {
        id: `capability:${capabilityId}`,
        kind: 'capability',
        properties: { name: 'Send Email', description: 'Sends an email to the claimant.' },
        confidence: 0.91,
        sourceRefs: [{ documentPath: 'claim.pdf', pages: [3], sourceConfidence: 0.9 }],
        tags: [],
      },
    ],
    edges: [],
  };
}

test('a capability-shaped node in knowledge_graph.json does not appear in CapabilityRegistry (the manifest.capabilities-only path)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({
      capabilities: [], // no manifest.capabilities at all
      knowledgeGraph: knowledgeGraphWithCapabilityLookingNode('send_email'),
    });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const capabilities = CapabilityRegistry.fromPackages(registry.all());

    assert.equal(capabilities.size, 0);
    assert.deepEqual(capabilities.find('send_email'), []);
    assert.deepEqual(capabilities.search('send_email'), []);
    assert.deepEqual(capabilities.search('Send Email'), []);
  });
});

test('negotiating a request for that id through the normal AI-provider pipeline finds no candidate at all', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({
      capabilities: [],
      knowledgeGraph: knowledgeGraphWithCapabilityLookingNode('send_email'),
    });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const context = buildRuntimeContext(registry, () => new Date('2026-01-01T00:00:00.000Z'));

    const negotiator = new CapabilityNegotiator();
    const request: ExecutionRequest = {
      requestId: RequestId('req-1'),
      capabilityId: 'send_email',
      environment: {
        environmentId: EnvironmentId('env-1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    };
    const plan = negotiator.plan(request, context);

    assert.equal(plan.status, 'no_candidates');
    assert.equal(plan.selected, undefined);
  });
});

test('the same capability id, explicitly registered in RuntimeCapabilityRegistry, is a completely independent fact — presence in one registry implies nothing about the other', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({
      capabilities: [],
      knowledgeGraph: knowledgeGraphWithCapabilityLookingNode('send_email'),
    });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const packageCapabilities = CapabilityRegistry.fromPackages(registry.all());

    const runtimeCapabilities = new RuntimeCapabilityRegistry();
    runtimeCapabilities.register({
      declaration: {
        capabilityId: 'send_email',
        inputContract: { description: 'to/subject/body' },
        outputContract: { description: 'delivery confirmation id' },
        handler: async (input) => ok(input),
      },
    });

    // Explicitly registering "send_email" as a Runtime capability does not
    // retroactively make the package's knowledge-graph data authoritative,
    // and the package's knowledge-graph data never caused this
    // registration — the two facts were established completely
    // independently, by two different, unrelated calls.
    assert.equal(packageCapabilities.size, 0);
    assert.equal(runtimeCapabilities.has('send_email'), true);
  });
});

test('end-to-end: explicit Runtime declaration + granted permission -> real execution; the package/knowledge-graph data plays no role in this path at all', async () => {
  const runtimeCapabilities = new RuntimeCapabilityRegistry();
  const registered = runtimeCapabilities.register({
    declaration: {
      capabilityId: 'send_email',
      inputContract: { description: '{ to: string; subject: string; body: string }' },
      outputContract: { description: '{ deliveryId: string }' },
      handler: async (input) => {
        const { to } = input as { to: string };
        return ok({ deliveryId: `mail_${to}` });
      },
    },
    requiredPermissions: [{ permission: Permissions.network.connect }],
  });
  assert.ok(registered.ok);

  const manager = new PermissionManager({
    policy: new RuleBasedPolicy([{ id: 'allow-network', effect: 'ALLOW', match: { permission: Permissions.network.connect } }]),
  });
  const executor = new RuntimeCapabilityExecutor({ registry: runtimeCapabilities, permissionManager: manager });

  const result = await executor.execute({ capabilityId: 'send_email', input: { to: 'claimant@example.com', subject: 'Update', body: 'Your claim was received.' } });
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value.output, { deliveryId: 'mail_claimant@example.com' });
});

test('the inverse of the above: same explicit declaration, permission NOT granted -> denied, never executes', async () => {
  const runtimeCapabilities = new RuntimeCapabilityRegistry();
  let handlerCalled = false;
  runtimeCapabilities.register({
    declaration: {
      capabilityId: 'send_email',
      inputContract: { description: 'to/subject/body' },
      outputContract: { description: 'delivery confirmation id' },
      handler: async (input) => {
        handlerCalled = true;
        return ok(input);
      },
    },
    requiredPermissions: [{ permission: Permissions.network.connect }],
  });

  const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) }); // default-deny
  const executor = new RuntimeCapabilityExecutor({ registry: runtimeCapabilities, permissionManager: manager });

  const result = await executor.execute({ capabilityId: 'send_email', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
  assert.equal(handlerCalled, false);
});
