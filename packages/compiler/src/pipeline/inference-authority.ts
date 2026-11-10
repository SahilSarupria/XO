import { ConfigError, ErrorCode, type XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { err, ok, type Result } from '@xo/types';

/** The slice of `AiCapabilityLayer` the compiler boundary needs (kept structural so tests can supply fakes). */
export interface BoundableAiLayer {
  inferenceBounded(): boolean;
}

/**
 * Compile-time inference authority check, run FIRST by every compile entrypoint that accepts `aiCore`
 * (`compileSources`, `compilePdfToXoir`, and therefore `compilePdfToPackage`).
 *
 * A supplied AI layer must be able to limit spend (an `inferenceScope` with a finite limit, or inference disabled). A layer that can
 * not is refused UNLESS the caller passes `allowUnboundedInference: true`, which must come from an explicit operator decision
 * (`XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE`, surfaced by `createCompilerAiLayer`). Omitting a limit therefore never silently yields an
 * unlimited compile. With no `aiCore` at all the compile is rule-based and nothing is checked.
 *
 * Scope note: this is a compile-time spend authority. It grants nothing to runtime execution, which has its own guard.
 */
export function checkCompileInferenceAuthority(
  aiCore: BoundableAiLayer | undefined,
  allowUnboundedInference: boolean | undefined,
  logger?: Logger,
): Result<void, XoError> {
  if (aiCore === undefined || aiCore.inferenceBounded()) return ok(undefined);
  if (allowUnboundedInference === true) {
    logger?.warn('compile inference is UNBOUNDED by explicit operator opt-in (allowUnboundedInference)', {});
    return ok(undefined);
  }
  return err(
    new ConfigError(
      ErrorCode.CONFIG_MISSING_KEY,
      'Refusing to compile with an AI layer that has no spend limit. Build it with createCompilerAiLayer (needs XO_COMPILER_MAX_TOTAL_TOKENS and/or XO_COMPILER_MAX_COST_USD), attach an inferenceScope with a limit, or explicitly pass allowUnboundedInference.',
    ),
  );
}
