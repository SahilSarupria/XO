import type { HostCapability, ModelFamily } from '@xo/types';
import { PackageInstaller } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { EnvironmentId, ExecutionEngine, RequestId, Runtime } from '@xo/runtime';
import type { ExecutionRequest } from '@xo/runtime';
import type { ModelProvider } from '@xo/ai-core';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { tryDeterministicRun } from './deterministic-router.js';

export interface RunOptions {
  readonly capabilityId?: string;
  readonly query?: string;
  readonly input: string;
  readonly storeDir: string;
  /** The concrete model id to send with every provider request — see `ExecutionEngineOptions.model`. Falls back to the provider's own first advertised model when omitted (same default `ExecutionEngine` itself applies); required for a provider (e.g. `ollama`) that advertises no models of its own. */
  readonly model?: string;
  /** Recorded on the request's `environment.provider` and, from there, on the `ExecutionReceipt` — a label, not something `ExecutionEngine` uses to pick a provider (the provider is already the one this caller constructed and passed in). */
  readonly providerLabel: string;
  readonly hostFamily?: ModelFamily;
  readonly hostCapabilities?: readonly HostCapability[];
  readonly tokenBudget?: number;
  readonly maxTokens?: number;
  readonly json?: boolean;
  readonly now?: () => Date;
  /** R3's CLI-level permission grant boundary — `xo run ... --grant <permissionId>` (repeatable). Only consulted by the deterministic path; the AI-provider path's own authorization is unchanged (see the R1–R3 report's "did not weaken the AI provider path" note). */
  readonly grantedPermissionIds?: readonly string[];
}

/** P1.0 M1 kill switch for model-assisted execution. Typed `boolean` (not a literal) so the guarded code stays type-checked. */
const AI_EXECUTION_ENABLED: boolean = false;
export const AI_EXECUTION_DISABLED_MESSAGE = 'AI-assisted execution is disabled: capability authorization is not yet enforced on this path (P1.0). Deterministic execution is unaffected.';

/**
 * This command does no planning, execution, prompt assembly, retrieval,
 * or provider-call logic of its own — it bootstraps a `Runtime` (mounts
 * whatever is installed under `--store`) and hands one `ExecutionRequest`
 * to `@xo/runtime`'s `ExecutionEngine`, which does all of that. This
 * file's own work is limited to: constructing the runtime/engine from
 * CLI options, shaping the request, and turning an `ExecutionResult`
 * into a `CommandResult`.
 *
 * Before any of that, it tries `tryDeterministicRun` — see that module's
 * doc comment for why. Only when a capability does NOT resolve to a
 * deterministic binding does this function need a `ModelProvider` at
 * all, which is why `provider` is a lazily-invoked resolver rather than
 * an already-constructed instance: constructing a provider (and, for
 * most providers, requiring an API key) is real work with a real failure
 * mode, and a deterministic capability must never pay that cost or hit
 * that failure. `provider-factory.ts`'s `resolveProvider` is what the
 * real CLI command wraps into this resolver; tests can pass their own
 * (e.g. one that always returns a scripted provider, or one that always
 * errors, to prove the deterministic path never calls it).
 */
export async function runCommand(options: RunOptions, resolveProvider: () => import('@xo/types').Result<ModelProvider, string>): Promise<CommandResult> {
  const now = options.now ?? (() => new Date());

  const installer = new PackageInstaller(new LocalFsBlobStore(options.storeDir));
  const runtime = new Runtime(installer, options.now !== undefined ? { now: options.now } : {});
  const bootstrap = await runtime.bootstrap();
  const bootstrapWarnings = bootstrap.failures.map((f) => `warning: "${f.name}@${f.version}" failed to mount: [${f.error.code}] ${f.error.message}`);

  // Set only when the deterministic router looked at this capability and
  // explicitly declined it (`not_deterministic`) — never for a bare
  // `--query` run, which never had a deterministic capability id to
  // decline in the first place. Every return on the AI-provider path
  // below is passed through `withDeterministicSkipNote` so that whatever
  // happens next (success, a provider-config failure, an execution
  // failure) is reported *in context*: a person seeing "needs an API
  // key" should also see, in the same output, that the reason they
  // reached the provider path at all is this specific, router-reported
  // decision — not left to guess whether the CLI is broken or the
  // capability just isn't deterministic. This adds a diagnostic only; it
  // does not change what got returned, what got executed, or which path
  // was taken.
  let deterministicSkipReason: string | undefined;

  function withDeterministicSkipNote(result: CommandResult): CommandResult {
    if (deterministicSkipReason === undefined) return result;
    if (options.json) {
      const [firstLine, ...rest] = result.lines;
      let payload: Record<string, unknown> = {};
      if (firstLine !== undefined) {
        try {
          payload = JSON.parse(firstLine) as Record<string, unknown>;
        } catch {
          // Not JSON (shouldn't happen on this path) — fall through and leave lines untouched below.
          return result;
        }
      }
      return { ...result, lines: [JSON.stringify({ ...payload, deterministicSkipReason }), ...rest] };
    }
    return {
      ...result,
      lines: [
        `note: deterministic execution was not selected for "${options.capabilityId}":`,
        `  ${deterministicSkipReason}`,
        'Falling back to model-assisted execution...',
        '',
        ...result.lines,
      ],
    };
  }

  // --- Deterministic path — tried FIRST, before any provider is ever
  // resolved. See deterministic-router.ts's doc comment. Only a
  // capability-id request (not a bare `--query`) can match here: a
  // deterministic binding is looked up by capability id, and a `--query`
  // request has no capability id yet (that's what CapabilityNegotiator's
  // ranking is for) — so a `--query`-only run always falls through to
  // the AI-provider path below, unchanged from before this router
  // existed.
  if (options.capabilityId !== undefined) {
    const deterministic = await tryDeterministicRun(options.capabilityId, options.input, installer, runtime.context().registry, options.grantedPermissionIds ?? []);
    if (deterministic.kind === 'executed') {
      if (options.json) {
        return ok([
          JSON.stringify({
            status: 'completed',
            executor: 'deterministic',
            modelCalled: false,
            source: deterministic.source,
            confidence: deterministic.confidence,
            bindingId: deterministic.bindingId,
            contractId: deterministic.contractId,
            sourceXoirNodeIds: deterministic.sourceXoirNodeIds,
            output: deterministic.output,
            warnings: bootstrapWarnings,
          }),
        ]);
      }
      return ok([
        ...bootstrapWarnings,
        '--- receipt ---',
        '  executor:              deterministic',
        '  modelCalled:           false',
        `  source:                ${deterministic.source}`,
        `  confidence:            ${deterministic.confidence}`,
        `  bindingId:             ${deterministic.bindingId}`,
        `  contractId:            ${deterministic.contractId}`,
        '',
        JSON.stringify(deterministic.output, null, 2),
      ]);
    }
    if (deterministic.kind === 'invalid_input') {
      return failWith(`invalid_input: capability "${options.capabilityId}" rejected --input: ${deterministic.issues.map((i) => `${i.property}: ${i.message}`).join('; ')}`);
    }
    if (deterministic.kind === 'confidence_ineligible') {
      return failWith(`confidence_ineligible: capability "${options.capabilityId}" has confidence ${deterministic.score}, below the ${deterministic.threshold} execution-eligibility threshold — refusing to execute deterministically rather than running on an under-confident capability`);
    }
    if (deterministic.kind === 'not_authorized') {
      return failWith(`not_authorized: ${deterministic.reason}`);
    }
    if (deterministic.kind === 'error') {
      return failWith(`deterministic execution failed for capability "${options.capabilityId}": ${deterministic.message}`);
    }
    // deterministic.kind === 'not_deterministic' — fall through to the
    // AI-provider path exactly as before this router existed, but record
    // why for withDeterministicSkipNote above.
    deterministicSkipReason = deterministic.reason;
  }

  // --- AI-provider path — P1.0 M1: DISABLED. `ExecutionEngine` is built
  // below with no `permissionGate` (allow-all) and the CLI has no
  // authenticated principal, so model-assisted execution would run with
  // no effective capability authorization. It stays unavailable until
  // the authorization gate (P1.0 M2) is enforced on this path. Refused
  // BEFORE the provider is resolved, so no API key/endpoint is read or
  // used. The deterministic path above is unaffected. The switch is a
  // code constant, not a flag, env var or config value.
  if (!AI_EXECUTION_ENABLED) {
    return withDeterministicSkipNote(failWith(AI_EXECUTION_DISABLED_MESSAGE));
  }

  // A provider is resolved only now, only because it's actually needed.
  const providerResult = resolveProvider();
  if (!providerResult.ok) {
    return withDeterministicSkipNote(failWith(providerResult.error));
  }
  const provider = providerResult.value;

  const models = provider.describeCapabilities().models;
  if (options.model === undefined && models.length === 0) {
    return withDeterministicSkipNote(failWith(`provider "${provider.id}" advertises no models of its own — pass --model explicitly`));
  }

  let engine: ExecutionEngine;
  try {
    engine = new ExecutionEngine(() => runtime.context(), installer, provider, options.model !== undefined ? { model: options.model } : {});
  } catch (cause) {
    return withDeterministicSkipNote(failWith(`could not construct the execution engine: ${(cause as Error).message}`));
  }

  const request: ExecutionRequest = {
    requestId: RequestId(`req_${now().getTime()}`),
    ...(options.capabilityId !== undefined ? { capabilityId: options.capabilityId } : {}),
    ...(options.query !== undefined ? { query: options.query } : {}),
    environment: {
      environmentId: EnvironmentId(`env_${now().getTime()}`),
      hostProfile: { family: options.hostFamily ?? 'claude', capabilities: options.hostCapabilities ?? ['chat', 'tool_use'] },
      provider: options.providerLabel,
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      createdAt: now().toISOString(),
    },
    requestedAt: now().toISOString(),
    input: options.input,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  };

  const result = await engine.execute(request);

  if (options.json) {
    return withDeterministicSkipNote(
      ok([
        JSON.stringify({
          status: result.session.status,
          executionId: result.executionId,
          response: result.response ?? null,
          receipt: result.receipt ?? null,
          error: result.error ? { code: result.error.code, message: result.error.message } : null,
          warnings: bootstrapWarnings,
        }),
      ]),
    );
  }

  if (result.error || !result.response) {
    return withDeterministicSkipNote({
      exitCode: 1,
      lines: [...bootstrapWarnings, `error: execution ${result.session.status}${result.error ? ` [${result.error.code}] ${result.error.message}` : ''}`],
    });
  }

  const receiptLines: string[] = [];
  if (result.receipt) {
    receiptLines.push(
      '--- receipt ---',
      `  executionId:          ${result.executionId}`,
      `  capabilitiesInvoked:  ${result.receipt.capabilitiesInvoked.join(', ') || '(none)'}`,
      `  tokens:               ${result.receipt.tokenUsage.promptTokens} prompt + ${result.receipt.tokenUsage.completionTokens} completion`,
      ...(result.receipt.estimatedCost ? [`  estimatedCost:        ${result.receipt.estimatedCost.amount} ${result.receipt.estimatedCost.currency}`] : []),
      `  durationMs:           ${result.receipt.executionDurationMs}`,
      `  degraded:             ${result.receipt.degraded ?? false}`,
    );
  }

  return withDeterministicSkipNote(ok([...bootstrapWarnings, result.response.content, '', ...receiptLines]));
}
