import type { ApiResult, XoApi } from './api-client.js';
import {
  EFFECT_FRESH_APPROVAL_REQUIRED_CODE,
  EFFECT_OUTCOME_UNKNOWN_CODE,
  EFFECT_PAYLOAD_APPROVAL_REQUIRED_CODE,
  parseToolName,
  readDetail,
  validateArguments,
} from './tools.js';

/**
 * P1.1 M5 — one tool invocation. Order is fixed and every early exit happens BEFORE the start request is sent:
 *   name -> API re-read of the exact version (approved? schema?) -> closed argument validation -> API start.
 * The result NEVER fabricates an outcome: a missing answer, a timeout, a cancellation or a 5xx on the start request is reported as
 * "outcome unknown, do not retry", not as failure and not as success.
 */

export interface ToolCallResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>>;
}

/** The tool does not exist as far as the API is concerned: reported as a protocol error, not a tool result. */
export class UnknownToolError extends Error {
  constructor() {
    super('unknown tool');
    this.name = 'UnknownToolError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function result(isError: boolean, structured: Record<string, unknown>, text: string): ToolCallResult {
  return { isError, text, structured };
}

function notStarted(reason: string, extra: Record<string, unknown> = {}): ToolCallResult {
  return result(true, { outcome: 'not_started', reason, ...extra }, `Nothing was started: ${reason}.`);
}

function unknownOutcome(reason: string): ToolCallResult {
  return result(
    true,
    { outcome: 'unknown', reason, retrySafe: false },
    `The outcome is UNKNOWN (${reason}). The procedure may or may not have started, and an external effect may have occurred. ` +
      'Do not retry automatically and do not assume it failed; check the procedure executions in XO.',
  );
}

function apiDenied(status: number, code: string | undefined, message: string | undefined): ToolCallResult {
  const where = `HTTP ${status}${code !== undefined ? `, ${code}` : ''}`;
  return result(
    true,
    { outcome: 'rejected', httpStatus: status, ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) },
    `The XO API rejected the request (${where})${message !== undefined ? `: ${message}` : ''}.`,
  );
}

export interface CallRequest {
  readonly name: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export async function callTool(api: XoApi, req: CallRequest): Promise<ToolCallResult> {
  const ref = parseToolName(req.name);
  if (ref === undefined) throw new UnknownToolError();

  // 1. The API is asked again, now: is this exact version approved, and what input does it accept?
  const got = await api.getProcedure(ref.procedureId, ref.version, req.signal);
  if (got.kind === 'api_error' && got.status === 404) throw new UnknownToolError();
  if (got.kind === 'api_error') return apiDenied(got.status, got.code, got.message);
  if (got.kind === 'no_answer') return notStarted(`the procedure could not be read from XO (${got.reason}); no start request was sent`);
  const detail = readDetail(ref, got.body);
  if (detail === undefined)
    return notStarted('this procedure version is not currently approved for execution, or has no usable input schema');

  // 2. Closed validation, before anything is sent. Values and unrecognized property names are never echoed.
  const args = req.arguments === undefined ? {} : req.arguments;
  const problems = validateArguments(detail.schema, args);
  if (problems.length > 0) {
    return result(
      true,
      { outcome: 'invalid_arguments', problems },
      `Nothing was started: the arguments were rejected (${problems.map((p) => `${p.property}: ${p.message}`).join('; ')}).`,
    );
  }

  // 3. The single start request. The API re-resolves everything; this adapter has no other way to run anything.
  const started = await api.startProcedure(ref.procedureId, ref.version, args as Record<string, unknown>, req.idempotencyKey, req.signal);
  return mapStart(started);
}

function mapStart(res: ApiResult): ToolCallResult {
  if (res.kind === 'no_answer') return unknownOutcome(`no usable answer from the XO API: ${res.reason}`);
  if (res.kind === 'api_error') {
    // 5xx and idempotency states can follow partial work; only a 4xx is a clean refusal.
    if (res.status >= 500 || (res.code !== undefined && res.code.startsWith('XO_IDEMPOTENCY_'))) {
      return unknownOutcome(`the XO API reported HTTP ${res.status}${res.code !== undefined ? ` (${res.code})` : ''} on the start request`);
    }
    return apiDenied(res.status, res.code, res.message);
  }
  return mapExecution(res.body);
}

function mapExecution(body: unknown): ToolCallResult {
  if (!isRecord(body) || typeof body['procedureExecutionId'] !== 'string' || typeof body['status'] !== 'string') {
    return unknownOutcome('the XO API answered with an unrecognized execution record');
  }
  const steps = Array.isArray(body['steps']) ? body['steps'] : [];
  const stepViews = steps.filter(isRecord).map((s) => ({
    stepId: s['stepId'],
    status: s['status'],
    ...(typeof s['failureClass'] === 'string' ? { failureClass: s['failureClass'] } : {}),
    ...(typeof s['errorCode'] === 'string' ? { errorCode: s['errorCode'] } : {}),
  }));
  const failure = isRecord(body['failure']) ? body['failure'] : undefined;
  const codes = [
    ...stepViews.map((s) => s.errorCode).filter((c): c is string => typeof c === 'string'),
    ...(failure !== undefined && typeof failure['code'] === 'string' ? [failure['code']] : []),
  ];
  const outcomeUnknown = codes.includes(EFFECT_OUTCOME_UNKNOWN_CODE);
  const status = body['status'];
  const base: Record<string, unknown> = {
    procedureExecutionId: body['procedureExecutionId'],
    status,
    steps: stepViews,
    ...(isRecord(body['outputs']) ? { outputs: body['outputs'] } : {}),
    ...(isRecord(body['waitingFor']) ? { waitingFor: body['waitingFor'] } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
  if (outcomeUnknown) {
    return result(
      true,
      { ...base, outcome: 'unknown', outcomeUnknown: true, retrySafe: false },
      `The procedure execution ${String(body['procedureExecutionId'])} stopped with an UNKNOWN external-effect outcome. ` +
        'The effect may have happened. Do not retry and do not treat this as a failure; it must be reconciled by an authorized human in XO.',
    );
  }
  if (status === 'completed') {
    return result(false, { ...base, outcome: 'completed' }, `Procedure execution ${String(body['procedureExecutionId'])} completed.`);
  }
  if (status === 'waiting_for_human') {
    const needsApproval = codes.includes(EFFECT_PAYLOAD_APPROVAL_REQUIRED_CODE) || codes.includes(EFFECT_FRESH_APPROVAL_REQUIRED_CODE);
    return result(
      false,
      { ...base, outcome: 'waiting_for_human', ...(needsApproval ? { approvalRequired: true } : {}) },
      `Procedure execution ${String(body['procedureExecutionId'])} is waiting for a human in XO${needsApproval ? ' (approval required)' : ''}. ` +
        'Approval and resolution cannot be done through MCP.',
    );
  }
  if (status === 'failed') {
    return result(
      true,
      { ...base, outcome: 'failed' },
      `Procedure execution ${String(body['procedureExecutionId'])} failed${failure !== undefined && typeof failure['code'] === 'string' ? ` (${failure['code']})` : ''}.`,
    );
  }
  return result(false, { ...base, outcome: status }, `Procedure execution ${String(body['procedureExecutionId'])} is ${status}.`);
}
