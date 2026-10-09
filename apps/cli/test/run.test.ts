import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { ModelProvider } from '@xo/ai-core';
import { runCommand } from '../src/commands/runtime/run.js';
import { withInstalledBundle, buildTestBundle, buildDeterministicClaimBundle, buildAuthoritativeClaimBundle } from './helpers.js';

/** `runCommand`'s provider param is a lazy resolver (see run.ts's doc comment on why) — this wraps an already-constructed test provider into that shape for tests that exercise the AI-provider path. */
const lazy = (provider: ModelProvider) => () => ({ ok: true as const, value: provider });

/** For tests proving the deterministic path never even calls the resolver. */
const shouldNeverResolve = () => {
  throw new Error('resolveProvider() must not be called for a deterministic capability');
};

test('P1.0 M1: run with a non-deterministic capability is refused — AI execution is disabled, and the provider is never resolved', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello there', storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.doesNotMatch(output, /--- receipt ---/);
  });
});

test('P1.0 M1: run --json on a non-deterministic capability is also refused, with no response/receipt fabricated', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.doesNotMatch(output, /"receipt"/);
  });
});

test('P1.0 M1: run against an unknown capabilityId is refused before any provider or engine is touched', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'does_not_exist', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
  });
});

test('run against an empty store (nothing installed) fails gracefully rather than throwing', async () => {
  const { withTempDir } = await import('./helpers.js');
  await withTempDir('xo-run-test-empty-store-', async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({}, undefined, 'test-model') }]);
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, lazy(provider));
    assert.equal(result.exitCode, 1);
  });
});

test('deterministic capability: claim_amount > 10000 executes locally with no AI provider ever resolved', async () => {
  const bundle = buildDeterministicClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.executor, 'deterministic');
    assert.equal(parsed.modelCalled, false);
    assert.equal(parsed.output.matched, true);
  });
});

test('deterministic capability: claim_amount below the threshold correctly does not match, still no AI provider', async () => {
  const bundle = buildDeterministicClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 500 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.executor, 'deterministic');
    assert.equal(parsed.modelCalled, false);
    assert.equal(parsed.output.matched, false);
  });
});

test('deterministic capability: repeated execution with identical input is deterministic (same output)', async () => {
  const bundle = buildDeterministicClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const first = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    const second = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.deepEqual(JSON.parse(first.lines[0]!).output, JSON.parse(second.lines[0]!).output);
  });
});

test('deterministic capability: a capability with no embedded contract no longer falls through to the AI-provider path — it is refused (P1.0 M1)', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
  });
});

// ============================================================
// R1 — authoritative execution metadata
// ============================================================

test('R1: an authoritative execution declaration is used (source: authoritative_declaration), no knowledge-graph scan needed for the routing decision', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.source, 'authoritative_declaration');
    assert.equal(parsed.modelCalled, false);
    assert.equal(parsed.output.matched, true);
  });
});

test('R1: the existing (pre-R1) fixture, with no execution field at all, still resolves via the explicit knowledge_graph_fallback path — proves backward compatibility, not silent behavior change', async () => {
  const bundle = buildDeterministicClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.source, 'knowledge_graph_fallback');
    assert.equal(parsed.modelCalled, false);
  });
});

test('R1: a non-deterministic declaration is declined by the deterministic router, then refused (AI disabled, P1.0 M1) — never silently executed', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'nonexistent_capability', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.doesNotMatch(output, /invalid_input|confidence_ineligible|not_authorized|deterministic execution failed/);
  });
});

// ============================================================
// R2 — input contract / schema validation
// ============================================================

test('R2: valid structured input matching the declared schema executes normally', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
  });
});

test('R2: wrong type ("hello" instead of a number) is rejected before execution, with no provider call', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 'hello' }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /invalid_input/);
    assert.match(result.lines.join('\n'), /claim_amount/);
  });
});

test('R2: a missing required field is rejected before execution, with no provider call', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ foo: 123 }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /invalid_input/);
    assert.match(result.lines.join('\n'), /missing required property|unknown property/);
  });
});

test('R2: null for a required numeric field is rejected before execution, with no provider call', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: null }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /invalid_input/);
  });
});

test('R2: an unknown property not declared in the schema is rejected before execution', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000, extra_field: true }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /invalid_input/);
    assert.match(result.lines.join('\n'), /extra_field/);
  });
});

test('R2: malformed JSON against a capability with a declared input schema is a hard invalid_input, not a silent fall-through to the AI provider', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: '{"claim_amount":', storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /invalid_input/);
  });
});

test('R2/hybrid-boundary: a capability with NO inputSchema and non-JSON input is declined by the deterministic router and then refused (AI disabled, P1.0 M1) — fail-closed, with the router reason still surfaced', async () => {
  const bundle = buildAuthoritativeClaimBundle({ inputSchema: null });
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: 'not json at all', storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.match(output, /deterministic execution was not selected/);
  });
});

// ============================================================
// R3 — confidence + authorization gating
// ============================================================

test('R3: a capability below the confidence threshold fails closed (confidence_ineligible), never executes, never calls the provider', async () => {
  const bundle = buildAuthoritativeClaimBundle({ confidence: 0.4 });
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /confidence_ineligible/);
  });
});

test('R3: a capability at or above the confidence threshold is eligible (boundary case, exactly at MIN_DETERMINISTIC_EXECUTION_CONFIDENCE)', async () => {
  const { MIN_DETERMINISTIC_EXECUTION_CONFIDENCE } = await import('../src/commands/runtime/deterministic-router.js');
  const bundle = buildAuthoritativeClaimBundle({ confidence: MIN_DETERMINISTIC_EXECUTION_CONFIDENCE });
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
  });
});

test('R3: a capability requiring a permission that was never granted is denied (not_authorized), never executes, never calls the provider', async () => {
  const bundle = buildAuthoritativeClaimBundle({ permissions: [{ permission: 'runtime.execute', capabilityId: 'claim_approval' }] });
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /not_authorized/);
  });
});

test('R3: the same permission-requiring capability succeeds once explicitly granted via --grant', async () => {
  const bundle = buildAuthoritativeClaimBundle({ permissions: [{ permission: 'runtime.execute', capabilityId: 'claim_approval' }] });
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand(
      { capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true, grantedPermissionIds: ['runtime.execute'] },
      shouldNeverResolve,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.output.matched, true);
  });
});

test('R3: a capability with no declared permission requirement at all remains permissionless (not silently denied) — matches the manifest\'s own default-deny-unless-declared model', async () => {
  const bundle = buildAuthoritativeClaimBundle(); // no .permissions option → no manifest permissions[] declared
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
  });
});

test('R3: the AI-provider path is disabled (P1.0 M1): refused before provider resolution, with the router decline reason still explained', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.match(output, /deterministic execution was not selected for "echo"/);
    assert.doesNotMatch(output, /API key/);
  });
});

test('diagnostics: the deterministic-skip note is attached to the AI-disabled refusal, in both text and JSON mode (P1.0 M1)', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const textResult = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, shouldNeverResolve);
    assert.equal(textResult.exitCode, 1);
    assert.match(textResult.lines.join('\n'), /deterministic execution was not selected for "echo"/);
    assert.match(textResult.lines.join('\n'), /AI-assisted execution is disabled/);

    const jsonResult = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model', json: true }, shouldNeverResolve);
    assert.equal(jsonResult.exitCode, 1);
    assert.match(jsonResult.lines.join('\n'), /AI-assisted execution is disabled/);
  });
});

test('diagnostics: a genuinely deterministic execution never carries a deterministicSkipReason — the note only appears when the router was actually consulted and declined', async () => {
  const bundle = buildDeterministicClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'claim_approval', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', json: true }, shouldNeverResolve);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.deterministicSkipReason, undefined);
  });
});

test('P1.0 M1: a provider that advertises no models is never even consulted — AI execution is refused first', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'ollama' }, shouldNeverResolve);
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /AI-assisted execution is disabled/);
    assert.doesNotMatch(output, /advertises no models/);
  });
});
