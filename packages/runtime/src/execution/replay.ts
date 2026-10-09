import { ErrorCode, RuntimeError } from '@xo/errors';
import type { ExecutionEngine } from '../engine/execution-engine.js';
import { deriveExecutionId } from '../engine/execution-id.js';
import type { ExecutionResult } from './execution-result.js';
import type { ExecutionRequest, ExecutionEnvironment } from './execution-request.js';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
import { createSession, withFailed, withReceipt } from '../session/execution-session.js';
import { ReceiptId, RequestId, EnvironmentId, type ExecutionId } from '../ids.js';

/**
 * R6 replay — see the R6 design's §6 for the full semantic contract.
 * Restated precisely, because it is what every branch below implements:
 *
 * "Replaying execution X means: given X's `ExecutionReceipt`,
 * reconstructing a new logical execution using the exact recorded
 * inputs and (for a `'deterministic_rule'` original) the exact
 * `contractId`/`bindingId` that ran — and re-invoking the model call for
 * a `'model'`-strategy original, but NEVER re-invoking a
 * `'deterministic_rule'` handler. Replay is reconstruction, not a
 * guaranteed reproduction of the original real-world side effects."
 *
 * This is deliberately NOT the same mechanism as simulation
 * (`execution/simulation-gate.ts`) — replay of a `'model'` original
 * makes a real, live provider call by default; only a
 * `'deterministic_rule'` original's replay avoids a live call, and it
 * does so by returning previously-recorded output, never by fabricating
 * one.
 */
export type ReplayMode = 'reconstruct-and-rerun-model' | 'recorded-output-only';

export interface ReplayOptions {
  /**
   * Only meaningful for a `'model'`-strategy original. Deterministic-
   * rule originals are ALWAYS `'recorded-output-only'` — see this
   * file's contract above — so passing `'reconstruct-and-rerun-model'`
   * for one is a caller error, refused explicitly rather than silently
   * downgraded.
   */
  readonly mode?: ReplayMode;
  /** Required for a `'model'`-strategy replay's real re-invocation — see this file's contract: replay never assumes the original mounted environment is still valid/available, the caller must supply one. Ignored for a `'recorded-output-only'` replay. */
  readonly environment?: ExecutionEnvironment;
  readonly now?: () => Date;
}

let replayCounter = 0;

/**
 * A placeholder `ExecutionEnvironment`, used only for the two replay
 * paths that never negotiate/execute against a real host (deterministic
 * reconstruction, and the failure/refusal path) — `createSession` just
 * needs a well-typed value to read `tokenBudget`/`provider` off of; no
 * negotiation ever runs against it, so its `hostProfile` is never
 * actually matched against anything.
 */
function placeholderReplayEnvironment(now: () => Date): ExecutionEnvironment {
  return { environmentId: EnvironmentId('replay-reconstruction'), hostProfile: { family: 'generic', capabilities: [] }, createdAt: now().toISOString() };
}

/**
 * Replays `originalReceipt` per this file's contract. Never mutates or
 * re-derives anything from `originalReceipt.executionId` itself — a
 * replay is always a NEW logical execution (fresh `ExecutionId`, derived
 * from a fresh, replay-specific `RequestId`), linked back to the
 * original only via the returned receipt's `replayOf` field, per the R6
 * design's §7 identity model.
 */
export async function replayExecution(engine: ExecutionEngine, originalReceipt: ExecutionReceipt, options: ReplayOptions = {}): Promise<ExecutionResult> {
  const now = options.now ?? (() => new Date());

  if (originalReceipt.hybridSteps !== undefined) {
    return failReplay(originalReceipt, now, 'Replay of a hybrid execution is deferred in this R6 pass — the original receipt does not record enough per-step information to reconstruct a hybrid invocation safely without risking re-running an already-completed step.');
  }

  const isDeterministicOriginal = originalReceipt.contractId !== undefined;

  if (isDeterministicOriginal) {
    if (options.mode === 'reconstruct-and-rerun-model') {
      return failReplay(originalReceipt, now, `Replay mode "reconstruct-and-rerun-model" was requested for execution "${originalReceipt.executionId}", whose original execution was "deterministic_rule" — a deterministic handler is never re-invoked by replay (see execution/replay.ts's contract); only "recorded-output-only" is valid for this receipt.`);
    }
    if (originalReceipt.recordedOutput === undefined) {
      return failReplay(originalReceipt, now, `Cannot replay execution "${originalReceipt.executionId}": its receipt does not carry a recordedOutput, so its deterministic_rule handler's original result cannot be reconstructed without re-invoking the handler, which replay never does.`);
    }
    return buildDeterministicReplayResult(originalReceipt, now);
  }

  // 'model'-strategy original.
  if (originalReceipt.recordedInputs === undefined) {
    return failReplay(originalReceipt, now, `Cannot replay execution "${originalReceipt.executionId}": its receipt does not carry recordedInputs, so the original request cannot be reconstructed.`);
  }
  if (options.environment === undefined) {
    return failReplay(originalReceipt, now, `Cannot replay execution "${originalReceipt.executionId}": a "model"-strategy replay re-invokes a real provider call and requires an explicit ExecutionEnvironment to be supplied — replay never assumes the original mounted environment is still valid.`);
  }
  const input = originalReceipt.recordedInputs['input'];
  if (typeof input !== 'string') {
    return failReplay(originalReceipt, now, `Cannot replay execution "${originalReceipt.executionId}": recordedInputs.input is not a string.`);
  }

  replayCounter += 1;
  const replayRequestId = RequestId(`${originalReceipt.requestId}::replay::${replayCounter}`);
  const replayRequest: ExecutionRequest = {
    requestId: replayRequestId,
    capabilityId: originalReceipt.capabilitiesInvoked[0] ?? '',
    input,
    environment: options.environment,
    requestedAt: now().toISOString(),
  };

  const result = await engine.execute(replayRequest);
  if (!result.receipt) return result;

  const replayedReceipt: ExecutionReceipt = Object.freeze({
    ...result.receipt,
    ...(originalReceipt.executionId !== undefined ? { replayOf: originalReceipt.executionId } : {}),
    replayMode: 'reconstruct-and-rerun-model' as const,
  });
  return { ...result, receipt: replayedReceipt, session: withReceipt(result.session, replayedReceipt, now) };
}

function buildDeterministicReplayResult(originalReceipt: ExecutionReceipt, now: () => Date): ExecutionResult {
  replayCounter += 1;
  const replayRequestId = RequestId(`${originalReceipt.requestId}::replay::${replayCounter}`);
  const executionId = deriveExecutionId(replayRequestId);
  const capabilityId = originalReceipt.capabilitiesInvoked[0] ?? '';

  const syntheticRequest: ExecutionRequest = {
    requestId: replayRequestId,
    capabilityId,
    input: JSON.stringify(originalReceipt.recordedInputs ?? {}),
    environment: placeholderReplayEnvironment(now),
    requestedAt: now().toISOString(),
  };
  const session = createSession(syntheticRequest, now);

  const replayedReceipt: ExecutionReceipt = Object.freeze({
    ...originalReceipt,
    receiptId: ReceiptId(`receipt_replay_${executionId}_${now().getTime()}`),
    requestId: replayRequestId,
    executionId,
    createdAt: now().toISOString(),
    ...(originalReceipt.executionId !== undefined ? { replayOf: originalReceipt.executionId } : {}),
    replayMode: 'recorded-output-only' as const,
  });

  const structuredResponse = {
    content: JSON.stringify(originalReceipt.recordedOutput),
    stopReason: 'end_turn' as const,
    usage: { promptTokens: 0, completionTokens: 0 },
    capabilityId,
    packageName: '',
    packageVersion: '',
    degraded: false,
  };

  const finalSession = withReceipt(session, replayedReceipt, now);
  return { executionId, session: finalSession, response: structuredResponse, receipt: replayedReceipt };
}

function failReplay(originalReceipt: ExecutionReceipt, now: () => Date, message: string): ExecutionResult {
  replayCounter += 1;
  const replayRequestId = RequestId(`${originalReceipt.requestId}::replay::${replayCounter}`);
  const executionId = deriveExecutionId(replayRequestId);
  const syntheticRequest: ExecutionRequest = {
    requestId: replayRequestId,
    capabilityId: originalReceipt.capabilitiesInvoked[0] ?? '',
    input: '',
    environment: placeholderReplayEnvironment(now),
    requestedAt: now().toISOString(),
  };
  const session = createSession(syntheticRequest, now);
  const error = new RuntimeError(ErrorCode.RUNTIME_REPLAY_SOURCE_UNAVAILABLE, message);
  return { executionId, session: withFailed(session, now), error };
}
