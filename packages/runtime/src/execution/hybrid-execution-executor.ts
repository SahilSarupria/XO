import type { ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { err, ok, type Result } from '@xo/types';
import type { HybridExecutionStep } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { validateCapabilityInput } from '@xo/capability-contract';
import type { CapabilityExecutor } from '../ai/capability-executor.js';
import type { RuntimeCapabilityExecutor } from '../capability-authority/runtime-capability-executor.js';

/**
 * R5. One `HybridExecutionStep`'s completed outcome, in declared order —
 * `HybridExecutionExecutor.execute`'s own step-by-step audit trail,
 * folded by `ExecutionPipeline` into the single capability invocation's
 * `ExecutionReceipt.hybridSteps` (see `session/execution-receipt.ts`).
 * `output` is deliberately `unknown`, not narrowed per strategy — a
 * `'deterministic_rule'` step's output is whatever its bound evaluator
 * returned (`RuntimeCapabilityExecutionResult.output`, itself
 * `unknown`); a `'model'` step's output is the provider's response text
 * (`string`). Later steps consume this via `HybridStepInputSource`, not
 * by inspecting this outcome record directly.
 */
export interface HybridStepOutcome {
  readonly stepId: string;
  readonly strategy: HybridExecutionStep['strategy'];
  readonly output: unknown;
}

/**
 * The whole hybrid sequence's outcome — exactly one per capability
 * invocation, matching every other execution path in this pipeline
 * (`'deterministic_rule'`, `'model'`) producing exactly one result.
 * `finalModelResponse` is present iff the *last* step to run was a
 * `'model'` step, so `ExecutionPipeline` can build the capability
 * invocation's `StructuredResponse`/token usage the exact same way the
 * single-strategy `'model'` path already does (via `ResponseAssembler`)
 * rather than a parallel code path; when the last step was
 * `'deterministic_rule'`, there is no `ProviderResponse` to assemble
 * from and the pipeline falls back to the same `JSON.stringify(output)`
 * convention `runDeterministicRuleExecution` already uses for a
 * deterministic-only capability.
 */
export interface HybridExecutionResult {
  readonly steps: readonly HybridStepOutcome[];
  readonly finalOutput: unknown;
  readonly finalModelResponse?: ProviderResponse;
}

/**
 * R5 cancellation fix. The exact same shape as `ExecutionPipeline`'s own
 * private `raceCancellation<T>(promise, cancellation)` — this type
 * exists only so that method can be passed into
 * `HybridExecutionExecutor.execute` (call-time, alongside
 * `buildProviderRequest`, for the same reason: this class has no
 * `ExecutionCancellation` of its own and must not invent one).
 * `ExecutionPipeline` supplies `(promise) =>
 * this.raceCancellation(promise, cancellation)`, so every awaited call
 * this class makes is raced against the *same* single whole-request
 * cancellation signal every other execution strategy on this pipeline
 * already respects — not a new, hybrid-specific cancellation mechanism,
 * and not per-step timeout/cancellation granularity (there is exactly
 * one `ExecutionCancellation` per capability invocation, hybrid or not;
 * this only makes sure each of a hybrid invocation's *sequential* awaits
 * individually observes it, the same way `ExecutionPipeline.prepare()`
 * already checks `cancellation.isCancelled` between its own sequential
 * stages).
 */
export type RaceCancellation = <T>(promise: Promise<T>) => Promise<{ readonly cancelled: false; readonly value: T } | { readonly cancelled: true }>;

/**
 * `HybridExecutionExecutor.execute`'s result. Mirrors
 * `ExecutionPipeline.raceCancellation`'s own `{cancelled: true} |
 * {cancelled: false, value}` shape exactly (with `result` in place of
 * `value`, since the non-cancelled case is itself a `Result`) so
 * `ExecutionPipeline` can dispatch to `terminateCancelled` vs.
 * `terminate` the same way `run()` already does for its own single
 * `raceCancellation` call.
 */
export type HybridExecutionOutcome = { readonly cancelled: true } | { readonly cancelled: false; readonly result: Result<HybridExecutionResult, RuntimeError> };

export interface HybridExecutionDeps {
  readonly capabilityExecutor: CapabilityExecutor;
  /** Same optionality, and same fail-closed meaning, as `ExecutionPipelineOptions.capabilityAuthorityExecutor` — a hybrid sequence containing a `'deterministic_rule'` step with this unconfigured fails exactly like a non-hybrid `'deterministic_rule'` capability would. */
  readonly capabilityAuthorityExecutor: RuntimeCapabilityExecutor | undefined;
}

/**
 * Builds the `ProviderRequest` for one `'model'` step, given the
 * effective input text that step should send. Supplied per-call by
 * `ExecutionPipeline` (not baked into `HybridExecutionDeps` at
 * construction time), because it closes over that one request's already
 * -assembled `AssembledContext` and prior-turn memory — both of which
 * only exist once `prepare()` has run its retrieval/context-assembly
 * steps for *this* invocation. `ExecutionPipeline` alone owns
 * `PromptAssembler`/`ContextAssembler`; this class never constructs a
 * `ProviderRequest` itself, so a hybrid model step is built through the
 * *exact* same machinery a non-hybrid `'model'` capability's single
 * request already is (see `ExecutionPipeline.prepare()`'s step 6), just
 * invoked once per model step instead of once per request.
 */
export type HybridProviderRequestBuilder = (effectiveInput: string) => ProviderRequest;

export interface HybridExecutionRequestInputs {
  /** The capability invocation's own free-text input — already safety-checked/redacted the same as the single-`'model'`-mode path (`ExecutionPipeline.prepare()`'s `effectiveInput`). Used by a step whose `input.kind === 'request'` and `strategy === 'model'`. */
  readonly requestInput: string;
  /** `request.structuredInput ?? {}` — used by a step whose `input.kind === 'request'` and `strategy === 'deterministic_rule'`, identical to `runDeterministicRuleExecution`'s own reading of it. */
  readonly structuredInput: Readonly<Record<string, unknown>>;
  /** The capability's own `declaration.id` — used only as the deterministic-authority `capabilityId` when a step doesn't declare its own `contractId`, mirroring `runDeterministicRuleExecution`'s `execution.contractId ?? selected.declaration.id` fallback. */
  readonly capabilityId: string;
}

/**
 * R5's dedicated hybrid-strategy executor. Reached from exactly one
 * place — `ExecutionPipeline.prepare()`'s existing R1/R4 dispatch point,
 * the same seam `runDeterministicRuleExecution` is reached from — never
 * from `ExecutionStrategyRouter` itself (whose only job stays "name a
 * strategy, execute nothing") and never from a second, independent
 * dispatch decision anywhere else.
 *
 * Runs `HybridExecutionStep`s strictly in declared order, threading each
 * step's output to whichever later step(s) reference it via
 * `HybridStepInputSource`. Stops immediately — never silently skipping a
 * step or continuing past a failure — on the first step that fails, for
 * any reason: R2 input-schema validation, missing capability authority,
 * a denied permission, a thrown/failed handler, or a failed provider
 * call. There is no partial success: a hybrid invocation either
 * completes every declared step or fails the whole invocation.
 *
 * Duplicates nothing: `'deterministic_rule'` steps run through
 * `validateCapabilityInput` (`@xo/capability-contract`, the same R2
 * primitive `runDeterministicRuleExecution` calls) and
 * `RuntimeCapabilityExecutor.execute` (the same R1 executor, unmodified,
 * doing its own independent registry-resolution + permission-check +
 * handler-invoke sequence); `'model'` steps run through
 * `CapabilityExecutor.execute` (the same, and only, place `@xo/runtime`
 * calls into `@xo/ai-core`). This class owns only sequencing,
 * input/output threading, and fail-closed short-circuiting — nothing
 * about how either strategy itself runs.
 *
 * Cancellation: every step's awaited call — a `'deterministic_rule'`
 * step's `RuntimeCapabilityExecutor.execute`, a `'model'` step's
 * `CapabilityExecutor.execute` — is raced against the caller-supplied
 * `RaceCancellation` (`ExecutionPipeline`'s own existing
 * `raceCancellation`, bound to the current request's single
 * `ExecutionCancellation`), exactly the same mechanism `run()` already
 * uses around its one AI-provider call. This is not a new,
 * hybrid-specific cancellation feature — it is the existing
 * whole-request cancellation contract applied to each of a hybrid
 * invocation's sequential awaits, the same way `prepare()` already
 * checks the same cancellation object between its own sequential
 * stages. No per-step timeout, no new cancellation reason, no
 * `AbortController` of this class's own.
 */
export class HybridExecutionExecutor {
  constructor(private readonly deps: HybridExecutionDeps) {}

  async execute(
    steps: readonly HybridExecutionStep[],
    inputs: HybridExecutionRequestInputs,
    buildProviderRequest: HybridProviderRequestBuilder,
    raceCancellation: RaceCancellation,
  ): Promise<HybridExecutionOutcome> {
    const outputsById = new Map<string, unknown>();
    const outcomes: HybridStepOutcome[] = [];
    let finalModelResponse: ProviderResponse | undefined;

    for (const step of steps) {
      const resolvedInput = this.resolveInput(step, inputs, outputsById);
      if (!resolvedInput.ok) return { cancelled: false, result: err(resolvedInput.error) };

      if (step.strategy === 'deterministic_rule') {
        const raced = await raceCancellation(this.runDeterministicStep(step, resolvedInput.value, inputs));
        if (raced.cancelled) return { cancelled: true };
        if (!raced.value.ok) return { cancelled: false, result: err(raced.value.error) };
        outputsById.set(step.stepId, raced.value.value);
        outcomes.push({ stepId: step.stepId, strategy: step.strategy, output: raced.value.value });
        finalModelResponse = undefined; // the most-recently-completed step was not a model step
        continue;
      }

      if (step.strategy !== 'model') {
        // Unreachable via normal TypeScript-checked code — `HybridStepStrategy`
        // is a closed `'deterministic_rule' | 'model'` union that does not
        // include `'hybrid'` (no recursive nesting) or anything else.
        // Reachable only via a deliberate cast, simulating a malformed or
        // future-widened step. Fails closed, exactly like
        // `ExecutionStrategyRouter.resolve` does for an unrecognized
        // capability-level mode — never silently treated as `'model'`.
        return {
          cancelled: false,
          result: err(
            new RuntimeError(
              ErrorCode.RUNTIME_UNSUPPORTED_EXECUTION_MODE,
              `Hybrid step "${step.stepId}" declares strategy "${String(step.strategy)}", which is not a strategy a hybrid step may use (only "deterministic_rule" or "model" — a hybrid step must never itself be "hybrid")`,
            ),
          ),
        };
      }

      // 'model'
      const effectiveInput = this.coerceToText(resolvedInput.value);
      const providerRequest = buildProviderRequest(effectiveInput);
      const raced = await raceCancellation(this.deps.capabilityExecutor.execute(providerRequest));
      if (raced.cancelled) return { cancelled: true };
      if (!raced.value.ok) return { cancelled: false, result: err(raced.value.error) };
      outputsById.set(step.stepId, raced.value.value.text);
      outcomes.push({ stepId: step.stepId, strategy: step.strategy, output: raced.value.value.text });
      finalModelResponse = raced.value.value;
    }

    const last = outcomes[outcomes.length - 1];
    /* istanbul ignore next -- callers (ExecutionPipeline.runHybridExecution) reject an empty hybridSteps list before ever constructing this executor's input, so `steps` is always non-empty in practice; defensive only */
    if (!last) return { cancelled: false, result: err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, 'Hybrid execution declared zero steps')) };

    return { cancelled: false, result: ok({ steps: outcomes, finalOutput: last.output, ...(finalModelResponse ? { finalModelResponse } : {}) }) };
  }

  /**
   * `'deterministic_rule'` step: R2 validation, then the same
   * `RuntimeCapabilityExecutor.execute` call `runDeterministicRuleExecution`
   * makes for a non-hybrid deterministic capability — identical
   * fail-closed behavior for a missing `capabilityAuthorityExecutor`,
   * identical `RUNTIME_CAPABILITY_INPUT_INVALID` shape for a schema
   * failure, identical `contractId ?? capabilityId` fallback.
   */
  private async runDeterministicStep(step: HybridExecutionStep, resolvedInput: unknown, inputs: HybridExecutionRequestInputs): Promise<Result<unknown, RuntimeError>> {
    const structured = this.coerceToRecord(resolvedInput, step.stepId);
    if (!structured.ok) return err(structured.error);

    if (step.inputSchema) {
      const validation = validateCapabilityInput(step.inputSchema, structured.value);
      if (!validation.valid) {
        const detail = validation.issues.map((issue) => `${issue.property}: ${issue.message}`).join('; ');
        return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, `Hybrid step "${step.stepId}" (deterministic_rule) input failed its declared input schema: ${detail}`));
      }
    }

    if (!this.deps.capabilityAuthorityExecutor) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED,
          `Hybrid step "${step.stepId}" declares strategy "deterministic_rule" but this pipeline has no capabilityAuthorityExecutor configured — refusing to fall back to the AI Capability Layer for a step that explicitly declared a deterministic strategy`,
        ),
      );
    }

    const capabilityId = step.contractId ?? inputs.capabilityId;
    const authorityResult = await this.deps.capabilityAuthorityExecutor.execute({ capabilityId, input: structured.value });
    if (!authorityResult.ok) return err(authorityResult.error);
    return ok(authorityResult.value.output);
  }

  /** `{ kind: 'request' }` reads the original invocation's own input (shape depends on `step.strategy`); `{ kind: 'step' }` reads an earlier step's already-recorded output — fails closed (never silently substitutes `undefined`) if the referenced step hasn't run, which given strict declared-order execution only happens for a forward/self reference. */
  private resolveInput(step: HybridExecutionStep, inputs: HybridExecutionRequestInputs, outputsById: ReadonlyMap<string, unknown>): Result<unknown, RuntimeError> {
    if (step.input.kind === 'request') {
      return ok(step.strategy === 'deterministic_rule' ? inputs.structuredInput : inputs.requestInput);
    }
    if (!outputsById.has(step.input.stepId)) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_INVALID_REQUEST,
          `Hybrid step "${step.stepId}" references the output of step "${step.input.stepId}", which has not run yet — a step may only reference a step declared strictly before it`,
        ),
      );
    }
    return ok(outputsById.get(step.input.stepId));
  }

  /**
   * A `'deterministic_rule'` step needs a `Record<string, unknown>`
   * structured input. An object value (typically another step's
   * deterministic output, or the original `structuredInput`) is used
   * directly; a string value (typically a prior `'model'` step's
   * response text) is accepted only if it parses as a JSON object —
   * the same "structured data, not prose" boundary R2 already enforces
   * for `request.structuredInput`, just sourced from a prior step's
   * output instead of the request. Anything else fails closed with the
   * same `RUNTIME_CAPABILITY_INPUT_INVALID` code R2 uses, rather than
   * guessing at an implicit wrapping shape.
   */
  private coerceToRecord(value: unknown, stepId: string): Result<Readonly<Record<string, unknown>>, RuntimeError> {
    if (this.isPlainRecord(value)) return ok(value);
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (this.isPlainRecord(parsed)) return ok(parsed);
      } catch {
        // falls through to the shared error below
      }
    }
    return err(
      new RuntimeError(
        ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID,
        `Hybrid step "${stepId}" (deterministic_rule) needs a JSON object input but received a value that is neither an object nor a JSON-object-parseable string`,
      ),
    );
  }

  private isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * A `'model'` step needs a text input. A string value (the original
   * request input, or a prior model step's response text) is used
   * directly; anything else (a prior deterministic step's structured
   * output) is `JSON.stringify`-ed — the exact same convention
   * `runDeterministicRuleExecution` already uses when building a
   * deterministic-only capability's `StructuredResponse.content`
   * (`JSON.stringify(authorityResult.value.output)`), reused here rather
   * than invented anew.
   */
  private coerceToText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}
