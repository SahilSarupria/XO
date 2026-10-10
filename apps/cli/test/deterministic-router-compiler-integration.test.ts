import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { packageXoirGraph } from '@xo/compiler';
import { PackageInstaller } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { runCommand } from '../src/commands/runtime/run.js';
import { withTempDir } from './helpers.js';

/**
 * Every other R1/R2/R3 test in `run.test.ts` proves the CLI's
 * `deterministic-router.ts` correctly *consumes* an authoritative
 * `execution` field — but does so against hand-built fixtures
 * (`buildAuthoritativeClaimBundle`), not a package the real `@xo/compiler`
 * ever actually produced. That was a deliberate, honest gap: until
 * `capability-lowering.ts#toCapabilityDeclaration` populated `execution`,
 * no real compiler output had one to test against.
 *
 * This file closes that gap for real: it builds a real `XoirGraph` (the
 * same fixture pattern `packager.test.ts` uses for its own
 * "resolved capability" coverage) and runs it through the actual,
 * unmocked `packageXoirGraph` — the exact function `xo create` itself
 * calls (`commands/compiler/create.ts`) — then installs the resulting
 * package and proves `xo run` takes the `authoritative_declaration` path.
 * No `execution` field is hand-authored anywhere in this test; every
 * field the router reads came out of the real `Packager` /
 * `lowerCapabilitiesToManifest`.
 *
 * Note on fixture choice: an earlier version of this test drove
 * `compileSources` on raw document text end-to-end. That is a more
 * complete real-world path, but a short fixture document's genuine
 * extraction confidence for a single-sentence rule lands below the
 * router's real `MIN_DETERMINISTIC_EXECUTION_CONFIDENCE = 0.7` gate — a
 * correct, intentional safety behavior of R3, not a bug to route around.
 * Building the `XoirGraph` directly (confidence 0.7, matching
 * `packager.test.ts`'s own `addResolvableCapability` fixture) isolates
 * this test to what it actually needs to prove — that a real,
 * `packageXoirGraph`-produced `execution` field is consumed by the CLI —
 * without coupling it to extraction-confidence tuning, which is a
 * distinct concern this task did not touch.
 */

const now = () => '2026-01-01T00:00:00.000Z';

function buildResolvableClaimGraph(): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId('g-cli-integration'));
  const capabilityId = 'capability:evaluate-claim-cli-integration';
  const decisionId = 'decision:deny-large-claim-cli-integration';
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: {
      name: 'Evaluate Claim',
      description: 'Evaluates a submitted claim against policy rules.',
      determinism: 'deterministic',
      requiredPermissions: [],
    },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claim assessment amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('req-cli-integration'),
    kind: 'REQUIRES',
    fromId: XoirNodeId(decisionId),
    toId: XoirNodeId(capabilityId),
    now,
  });
  return { graph, capabilityId };
}

test('a package built by the real, unmocked packageXoirGraph produces an execution field the CLI R1 path actually uses', async () => {
  const { graph, capabilityId } = buildResolvableClaimGraph();
  const packaged = packageXoirGraph(graph, {
    identity: { name: 'xo_real_compiler_integration_pkg', version: '1.0.0', creatorDid: 'did:xo:integration-test' },
    metadata: { domain: 'testing', description: 'Real-compiler integration fixture', scope: ['testing'], limitations: [] },
  });
  assert.ok(packaged.ok);
  if (!packaged.ok) return;

  // The real Packager actually resolved and lowered this capability — if
  // this fails, the rest of the test is meaningless (nothing to route).
  assert.equal(packaged.value.capabilities.resolvedCount, 1);
  const declaration = packaged.value.manifest.capabilities?.[0];
  assert.ok(declaration, 'expected packageXoirGraph to have lowered exactly one CapabilityDeclaration');
  assert.equal(declaration!.id, capabilityId);
  assert.ok(
    declaration!.execution,
    'expected the real compiler output to populate CapabilityDeclaration.execution (this is the fix under test)',
  );
  assert.equal(declaration!.execution!.mode, 'deterministic_rule');

  await withTempDir('xo-cli-test-compiler-integration-', async (storeDir) => {
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const installResult = await installer.install(packaged.value.bundle);
    assert.ok(installResult.ok, installResult.ok ? undefined : JSON.stringify((installResult as { error: unknown }).error));

    const shouldNeverResolve = () => {
      throw new Error('resolveProvider() must not be called for a real, compiler-produced deterministic capability');
    };

    const result = await runCommand(
      { capabilityId, input: JSON.stringify({ claim_assessment_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true },
      shouldNeverResolve,
    );

    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);
    // The real proof: the router used the authoritative `execution` field
    // this test never hand-authored — a real, compiler-produced R1 path,
    // not the knowledge_graph_fallback scan.
    assert.equal(parsed.executor, 'deterministic');
    assert.equal(parsed.modelCalled, false);
    assert.equal(parsed.source, 'authoritative_declaration');
    assert.equal(parsed.contractId, declaration!.execution!.contractId);
    assert.equal(parsed.bindingId, declaration!.execution!.bindingId);
  });
});

test('knowledge_graph fallback remains available for backward compatibility: a package with execution stripped off its manifest declaration still resolves deterministically', async () => {
  // Same real package build, but this time we simulate a pre-R1-fix
  // package by stripping `execution` back off the lowered declaration
  // before installing — proving the fallback path this router shipped
  // with originally is still intact and not accidentally made
  // unreachable now that real packages have an `execution` field.
  const { graph, capabilityId } = buildResolvableClaimGraph();
  const packaged = packageXoirGraph(graph, {
    identity: { name: 'xo_real_compiler_fallback_pkg', version: '1.0.0', creatorDid: 'did:xo:integration-test' },
    metadata: { domain: 'testing', description: 'Real-compiler fallback fixture', scope: ['testing'], limitations: [] },
  });
  assert.ok(packaged.ok);
  if (!packaged.ok) return;

  const declaration = packaged.value.manifest.capabilities?.[0];
  assert.ok(declaration);
  const { execution, ...withoutExecution } = declaration!;
  void execution;
  const strippedBundle = {
    ...packaged.value.bundle,
    manifest: { ...packaged.value.bundle.manifest, capabilities: [withoutExecution] },
  };

  await withTempDir('xo-cli-test-compiler-fallback-', async (storeDir) => {
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const installResult = await installer.install(strippedBundle);
    assert.ok(installResult.ok, installResult.ok ? undefined : JSON.stringify((installResult as { error: unknown }).error));

    const shouldNeverResolve = () => {
      throw new Error('resolveProvider() must not be called for a deterministic capability reached via the knowledge_graph fallback');
    };

    const result = await runCommand(
      { capabilityId, input: JSON.stringify({ claim_assessment_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true },
      shouldNeverResolve,
    );

    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.source, 'knowledge_graph_fallback');
    assert.equal(parsed.modelCalled, false);
  });
});
