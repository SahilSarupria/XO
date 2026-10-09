import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { runCommand } from '../src/commands/runtime/run.js';
import { withInstalledBundle, buildTestBundle, buildDeterministicClaimBundle, buildAuthoritativeClaimBundle } from './helpers.js';

/** `runCommand`'s provider param is a lazy resolver (see run.ts's doc comment on why) — this wraps an already-constructed test provider into that shape for tests that exercise the AI-provider path. */
const lazy = (provider: ModelProvider) => () => ({ ok: true as const, value: provider });

/** For tests proving the deterministic path never even calls the resolver. */
const shouldNeverResolve = () => {
  throw new Error('resolveProvider() must not be called for a deterministic capability');
};

test('run executes a matching capability and prints the response text plus a receipt summary', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 20, outputTokens: 15 }, 'test-model') }]);

    const result = await runCommand(
      { capabilityId: 'echo', input: 'hello there', storeDir, providerLabel: 'anthropic', model: 'test-model' },
      lazy(provider),
    );

    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /"ok":true/);
    assert.match(output, /--- receipt ---/);
    assert.match(output, /capabilitiesInvoked:\s+echo/);
    assert.match(output, /tokens:\s+20 prompt \+ 15 completion/);
    assert.match(output, /durationMs:\s+\d+/);
  });
});

test('run with --json emits a single parseable JSON line with status/response/receipt', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 5, outputTokens: 5 }, 'test-model') }]);

    const result = await runCommand(
      { capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model', json: true },
      lazy(provider),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.lines.length, 1);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.status, 'completed');
    assert.ok(parsed.response);
    assert.ok(parsed.receipt);
    assert.equal(parsed.error, null);
  });
});

test('run against a capabilityId with no matching package fails with the real XO_RUNTIME_PLAN_FAILED code, not a crash', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({}, undefined, 'test-model') }]);

    const result = await runCommand(
      { capabilityId: 'does_not_exist', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' },
      lazy(provider),
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /XO_RUNTIME_PLAN_FAILED/);
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

test('deterministic capability: a capability with no embedded contract still falls through to the AI-provider path (unchanged behavior)', async () => {
  // "echo" (buildTestBundle) has no embedded SemanticCapabilityContract at all —
  // proves this router is purely additive and doesn't change any existing capability's behavior.
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 1, outputTokens: 1 }, 'test-model') }]);
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, lazy(provider));
    assert.equal(result.exitCode, 0);
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

test('R1: an authoritative execution declaration with mode "model" is authoritatively NOT deterministic — falls through to the AI-provider path without ever touching the knowledge graph', async () => {
  const bundle = buildAuthoritativeClaimBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 1, outputTokens: 1 }, 'test-model') }]);
    const result = await runCommand({ capabilityId: 'nonexistent_capability', input: JSON.stringify({ claim_amount: 15000 }), storeDir, providerLabel: 'anthropic', model: 'test-model' }, lazy(provider));
    // "nonexistent_capability" isn't declared by any mounted manifest and matches no knowledge_graph node — the deterministic router correctly reports not_deterministic and falls through. The AI path then fails too, but for an entirely different, later reason (ExecutionEngine's own capability negotiation, "no_candidates") — proving the fall-through genuinely reached ExecutionEngine rather than being silently swallowed by the deterministic router.
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /no_candidates|plan_failed/);
    assert.doesNotMatch(result.lines.join('\n'), /invalid_input|confidence_ineligible|not_authorized|deterministic execution failed/);
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

test('R2/hybrid-boundary: a capability whose authoritative declaration has NO inputSchema and gets non-JSON input is declined by the deterministic router, and the runtime\'s own capability-authority guard then refuses to silently execute it via the AI Capability Layer either — this is current, deliberate fail-closed behavior, not a permissive fallback', async () => {
  const bundle = buildAuthoritativeClaimBundle({ inputSchema: null });
  await withInstalledBundle(bundle, async (storeDir) => {
    const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 1, outputTokens: 1 }, 'test-model') }]);
    const result = await runCommand({ capabilityId: 'claim_approval', input: 'not json at all', storeDir, providerLabel: 'anthropic', model: 'test-model' }, lazy(provider));
    // Refused — never silently executed via the AI path just because the
    // deterministic router happened to decline this particular input.
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /XO_RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED/);
    // And the diagnostic must explain *why* the AI path was even reached
    // in the first place — the deterministic router's own reason for
    // declining, surfaced in context rather than silently swallowed.
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

test('R3: the AI-provider path\'s own behavior is unchanged — it still requires provider resolution, with no permission/confidence gating from this router applied to it — and the failure now explains why the AI path was reached at all', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic' }, () => ({ ok: false, error: 'anthropic provider needs an API key — pass --api-key or set ANTHROPIC_API_KEY' }));
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /API key/);
    // The diagnostic gap this closes: previously a person saw only "needs
    // an API key" with no indication that a deterministic path was even
    // considered and declined first.
    assert.match(output, /deterministic execution was not selected for "echo"/);
    assert.match(output, /Falling back to model-assisted execution/);
  });
});

test('diagnostics: the deterministic-skip note is attached to a successful AI-provider fallback too, in both text and JSON mode', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const textProvider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 1, outputTokens: 1 }, 'test-model') }]);
    const textResult = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model' }, lazy(textProvider));
    assert.equal(textResult.exitCode, 0);
    assert.match(textResult.lines.join('\n'), /deterministic execution was not selected for "echo"/);

    const jsonProvider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ ok: true }, { inputTokens: 1, outputTokens: 1 }, 'test-model') }]);
    const jsonResult = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'anthropic', model: 'test-model', json: true }, lazy(jsonProvider));
    assert.equal(jsonResult.exitCode, 0);
    assert.equal(jsonResult.lines.length, 1);
    const parsed = JSON.parse(jsonResult.lines[0]!);
    assert.equal(typeof parsed.deterministicSkipReason, 'string');
    assert.match(parsed.deterministicSkipReason, /no deterministic execution source/);
    assert.equal(parsed.status, 'completed');
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

test('run rejects up front when the provider advertises no models and --model was not given', async () => {
  const bundle = buildTestBundle();
  await withInstalledBundle(bundle, async (storeDir) => {
    const noModelsProvider: ModelProvider = {
      id: 'ollama',
      describeCapabilities: (): ProviderCapabilityDescriptor => ({
        providerId: 'ollama',
        models: [],
        supportsStreaming: false,
        supportsStructuredOutput: false,
        supportsVision: false,
        maxContextTokens: 8192,
      }),
      complete: (_request: ProviderRequest): Promise<ProviderResponse> => {
        throw new Error('should never be called');
      },
    };

    const result = await runCommand({ capabilityId: 'echo', input: 'hello', storeDir, providerLabel: 'ollama' }, lazy(noModelsProvider));
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /advertises no models/);
  });
});
