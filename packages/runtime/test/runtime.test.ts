import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { buildContractLawyerBundle, buildFraudDetectorBundle, withTempInstaller } from './fixtures.js';

test('Runtime.bootstrap() discovers and mounts every installed package end to end', async () => {
  await withTempInstaller(async (installer) => {
    const lawyer = buildContractLawyerBundle();
    const fraud = buildFraudDetectorBundle();
    await installer.install(lawyer);
    await installer.install(fraud);

    const runtime = new Runtime(installer);
    const { registry, failures } = await runtime.bootstrap();

    assert.equal(failures.length, 0);
    assert.equal(registry.mountCount, 2);
    assert.equal(runtime.context().capabilities.size, 3); // contract_analysis + clause_lookup + fraud_detection
  });
});

test('Runtime.plan() selects the mounted contract_analysis capability for a compatible Claude host', async () => {
  await withTempInstaller(async (installer) => {
    const lawyer = buildContractLawyerBundle();
    await installer.install(lawyer);

    const runtime = new Runtime(installer);
    await runtime.bootstrap();

    const request: ExecutionRequest = {
      requestId: RequestId('req_1'),
      capabilityId: 'contract_analysis',
      environment: {
        environmentId: EnvironmentId('env_1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    };

    const plan = runtime.plan(request);
    assert.equal(plan.status, 'planned');
    assert.equal(plan.selected?.capability.packageName, lawyer.manifest.name);
    assert.notEqual(plan.selected?.compatibility.reachedLevel, 'L0');
  });
});

test('Runtime.mount()/unmount()/reload() thread an updated context through the facade', async () => {
  await withTempInstaller(async (installer) => {
    const lawyer = buildContractLawyerBundle();
    await installer.install(lawyer);
    const runtime = new Runtime(installer);

    const mounted = await runtime.mount(lawyer.manifest.name, lawyer.manifest.version);
    assert.ok(mounted.ok);
    if (mounted.ok) assert.equal(mounted.value.registry.mountCount, 1);

    const unmounted = runtime.unmount(lawyer.manifest.name, lawyer.manifest.version);
    assert.ok(unmounted.ok);
    if (unmounted.ok) assert.equal(unmounted.value.registry.mountCount, 0);

    const reloaded = await runtime.reload(lawyer.manifest.name, lawyer.manifest.version);
    assert.ok(reloaded.ok);
    if (reloaded.ok) assert.equal(reloaded.value.registry.mountCount, 1);
  });
});

test('Runtime never mutates a RuntimeContext already handed to a caller', async () => {
  await withTempInstaller(async (installer) => {
    const lawyer = buildContractLawyerBundle();
    await installer.install(lawyer);
    const runtime = new Runtime(installer);

    const before = runtime.context();
    await runtime.mount(lawyer.manifest.name, lawyer.manifest.version);
    assert.equal(before.registry.mountCount, 0, 'a previously returned context snapshot must remain unchanged');
  });
});
