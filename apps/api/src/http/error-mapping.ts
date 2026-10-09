import { ErrorCode, XoError } from '@xo/errors';
import type { ApiResponse } from './types.js';

/**
 * The one place `ErrorCode` -> HTTP status is decided. Every route
 * funnels its failures through `errorToResponse()` below rather than
 * picking a status inline — the same "one shared path, not ad hoc
 * per-handler logic" shape `apps/cli`'s `printResult`/`CommandResult`
 * uses for exit codes (see `command-result.ts`).
 *
 * Every current `ErrorCode` value (error-codes.ts) has an explicit
 * entry here — `error-mapping.test.ts` asserts that directly, so a
 * newly added code without a mapping decision fails a test instead of
 * silently falling through to 500. The status choices themselves are
 * judgment calls (the codes predate this HTTP layer and were never
 * designed with a status in mind); the reasoning for each group is
 * inline below, and README.md's "Error mapping" section restates it
 * for a reader who doesn't want to read this whole file.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // Generic / cross-cutting
  [ErrorCode.UNKNOWN]: 500,
  [ErrorCode.INVALID_ARGUMENT]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ALREADY_EXISTS]: 409,
  [ErrorCode.PRECONDITION_FAILED]: 412,
  [ErrorCode.UNIMPLEMENTED]: 501,
  [ErrorCode.IO_ERROR]: 502,

  // Configuration — always a server-side misconfiguration, never the caller's fault
  [ErrorCode.CONFIG_MISSING_KEY]: 500,
  [ErrorCode.CONFIG_INVALID_VALUE]: 500,

  // Serialization — the caller sent something structurally unreadable
  [ErrorCode.SERIALIZATION_SCHEMA_MISMATCH]: 400,
  [ErrorCode.SERIALIZATION_PARSE_FAILED]: 400,

  // Crypto — a hash/signature mismatch means the content itself is bad
  // (tampered or wrong), which is a 400-class problem from the API's
  // point of view even though it's detected deep in a library; a
  // missing key is closer to "the thing you asked about isn't here".
  [ErrorCode.CRYPTO_HASH_MISMATCH]: 400,
  [ErrorCode.CRYPTO_SIGNATURE_INVALID]: 400,
  [ErrorCode.CRYPTO_KEY_NOT_FOUND]: 404,

  // Storage — an internal I/O layer failing is a server-side problem
  [ErrorCode.STORAGE_OBJECT_NOT_FOUND]: 404,
  [ErrorCode.STORAGE_WRITE_FAILED]: 502,

  // Dependency injection — never a caller-facing failure mode, always a bug
  [ErrorCode.DI_TOKEN_NOT_REGISTERED]: 500,
  [ErrorCode.DI_CIRCULAR_DEPENDENCY]: 500,

  // Packages (@xo/package-sdk) — 422, not 400: the request was
  // well-formed (a byte stream, valid JSON) but the *package* it
  // describes fails a domain-level check the request itself couldn't
  // have caught client-side.
  [ErrorCode.PACKAGE_MANIFEST_INVALID]: 422,
  [ErrorCode.PACKAGE_VERSION_INVALID]: 422,
  [ErrorCode.PACKAGE_CORRUPT]: 422,
  [ErrorCode.PACKAGE_COMPONENT_MISSING]: 422,
  [ErrorCode.PACKAGE_VALIDATION_FAILED]: 422,
  [ErrorCode.PACKAGE_ALREADY_INSTALLED]: 409,
  [ErrorCode.PACKAGE_NOT_INSTALLED]: 404,
  [ErrorCode.PACKAGE_UPGRADE_INVALID]: 409,

  // Package dependency resolution
  [ErrorCode.PACKAGE_DEPENDENCY_CYCLE]: 409,
  [ErrorCode.PACKAGE_DEPENDENCY_CONFLICT]: 409,
  [ErrorCode.PACKAGE_DEPENDENCY_UNRESOLVED]: 422,
  [ErrorCode.PACKAGE_LOCKFILE_INVALID]: 422,
  [ErrorCode.PACKAGE_LOCKFILE_STALE]: 409,

  // Runtime — mount/session lifecycle
  [ErrorCode.RUNTIME_MOUNT_FAILED]: 500,
  [ErrorCode.RUNTIME_ALREADY_MOUNTED]: 409,
  [ErrorCode.RUNTIME_NOT_MOUNTED]: 404,
  [ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND]: 404,
  [ErrorCode.RUNTIME_NO_COMPATIBLE_PACKAGE]: 422,
  [ErrorCode.RUNTIME_PLAN_FAILED]: 422,
  [ErrorCode.RUNTIME_SESSION_INVALID_STATE]: 409,
  // Runtime — execution pipeline
  [ErrorCode.RUNTIME_INVALID_REQUEST]: 400,
  [ErrorCode.RUNTIME_RETRIEVAL_FAILED]: 502,
  [ErrorCode.RUNTIME_SAFETY_BLOCKED]: 403,
  [ErrorCode.RUNTIME_BUDGET_EXCEEDED]: 429,
  [ErrorCode.RUNTIME_EXECUTION_FAILED]: 502,
  [ErrorCode.RUNTIME_EXECUTION_TIMEOUT]: 504,
  // Not a standard code; 409 (state no longer valid) reads better across
  // HTTP clients than the nonstandard nginx-ism 499.
  [ErrorCode.RUNTIME_EXECUTION_CANCELLED]: 409,
  [ErrorCode.RUNTIME_PERMISSION_DENIED]: 403,

  // Runtime — capability authority (RuntimeCapabilityExecutor et al.,
  // first reachable over HTTP via P0.5's execution route)
  // A well-formed request whose *capability* just doesn't clear the
  // confidence floor — a domain-level rejection, same reasoning as the
  // PACKAGE_* 422s below, not a malformed request.
  [ErrorCode.RUNTIME_CONFIDENCE_BELOW_THRESHOLD]: 422,
  // Never the caller's fault — the host process didn't wire up a
  // RuntimeCapabilityRegistry/executor at all.
  [ErrorCode.RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED]: 500,
  [ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID]: 400,
  // The capability resolved to a real binding, but this host doesn't
  // (yet) execute that implementation class — a real, named limitation,
  // not a caller mistake or a server bug.
  [ErrorCode.RUNTIME_UNSUPPORTED_EXECUTION_MODE]: 422,
  // A malformed RuntimeCapabilityDeclaration is a host/registration bug, never a caller-facing 4xx.
  [ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID]: 500,
  [ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE]: 501,
  [ErrorCode.RUNTIME_RETRY_EXHAUSTED]: 502,
  [ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY]: 501,
  [ErrorCode.RUNTIME_EXECUTION_ALREADY_IN_FLIGHT]: 409,
  [ErrorCode.RUNTIME_REPLAY_SOURCE_UNAVAILABLE]: 500,
  // Not thrown as a top-level route error in this codebase today (P0.6's
  // resolve route always embeds it as a structured field inside a 200
  // response body — see `executions/resume-human-task.ts`'s doc
  // comment) — mapped here anyway for the same defensive-completeness
  // reason every other code in this table is, and 501 is the correct
  // status if a future caller ever does throw it directly: "the server
  // understands the request but doesn't (yet) implement this capability."
  [ErrorCode.HITL_RESUME_UNSUPPORTED]: 501,

  // P0.8 — the workflow exists but the existing executability audit does
  // not authorize running it. A well-formed request about a real
  // resource that cannot be processed in its current evidence state —
  // 422, same reasoning as BINDING_UNRESOLVED/CONTRACT_MALFORMED above.
  [ErrorCode.WORKFLOW_NOT_EXECUTABLE]: 422,

  // Capability contract (@xo/capability-contract) — semantic discovery
  // and binding resolution, first reachable over HTTP via P0.5.
  // capabilityId doesn't correspond to a real capability node in this compilation's graph.
  [ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND]: 404,
  // A real node, but not (or no longer) a `capability`-kind one — a domain-level mismatch.
  [ErrorCode.CONTRACT_SOURCE_NODE_INVALID]: 422,
  [ErrorCode.CONTRACT_MALFORMED]: 422,
  // The three BindingOutcome failure statuses (unresolved/ambiguous/denied)
  // are all "this specific capability isn't (yet) executable" — a
  // well-formed request about a real capability, not a 400/500. `DENIED`
  // reads closer to an authorization-flavored rejection, matching
  // RUNTIME_PERMISSION_DENIED's 403 above; the other two are plain 422s.
  [ErrorCode.BINDING_UNRESOLVED]: 422,
  [ErrorCode.BINDING_AMBIGUOUS]: 422,
  [ErrorCode.BINDING_DENIED]: 403,

  // XOIR — compiler intermediate representation
  [ErrorCode.XOIR_DUPLICATE_NODE]: 422,
  [ErrorCode.XOIR_DUPLICATE_EDGE]: 422,
  [ErrorCode.XOIR_DANGLING_EDGE]: 422,
  [ErrorCode.XOIR_CYCLE_DETECTED]: 422,
  [ErrorCode.XOIR_HASH_MISMATCH]: 400,
  [ErrorCode.XOIR_VALIDATION_FAILED]: 422,
  [ErrorCode.XOIR_MERGE_CONFLICT]: 409,
  [ErrorCode.XOIR_SCHEMA_VERSION_UNSUPPORTED]: 400,
  [ErrorCode.XOIR_PASS_FAILED]: 500,
  [ErrorCode.XOIR_PASS_CANCELLED]: 409,

  // Compiler frontend — PDF loading (not reachable through today's
  // compiler adapter, which only accepts 'xoir' input — see
  // compileAdapter.ts — but mapped for completeness/forward-compat)
  [ErrorCode.PDF_MALFORMED]: 422,
  [ErrorCode.PDF_UNSUPPORTED_FEATURE]: 422,
  [ErrorCode.PDF_ENCRYPTED]: 422,

  // AI Capability Layer
  [ErrorCode.AI_PROVIDER_REQUEST_FAILED]: 502,
  [ErrorCode.AI_ALL_PROVIDERS_FAILED]: 502,
  [ErrorCode.AI_NO_ELIGIBLE_PROVIDER]: 503,
  [ErrorCode.AI_RATE_LIMITED]: 429,
  [ErrorCode.AI_CIRCUIT_OPEN]: 503,
  [ErrorCode.AI_SCHEMA_VALIDATION_FAILED]: 502,
  [ErrorCode.AI_PROMPT_NOT_FOUND]: 404,
  [ErrorCode.AI_REPLAY_FIXTURE_MISSING]: 500,

  // Permissions
  [ErrorCode.PERMISSION_INVALID_REQUEST]: 400,
  [ErrorCode.PERMISSION_STORE_ERROR]: 500,
  [ErrorCode.PERMISSION_POLICY_INVALID]: 500,

  // Registry (@xo/registry)
  [ErrorCode.REGISTRY_PACKAGE_UNVERIFIED]: 422,
  [ErrorCode.REGISTRY_PACKAGE_ALREADY_PUBLISHED]: 409,
  [ErrorCode.REGISTRY_BENCHMARK_ALREADY_RECORDED]: 409,
  [ErrorCode.REGISTRY_ROYALTY_SPLIT_INVALID]: 422,
  [ErrorCode.REGISTRY_LICENSE_ALREADY_EXISTS]: 409,
  // A tampered ledger is a server-side data-integrity problem, not
  // something the caller did — 500, not 409/400.
  [ErrorCode.REGISTRY_LEDGER_TAMPERED]: 500,
  [ErrorCode.REGISTRY_LEDGER_ENTRY_NOT_FOUND]: 404,

  // Auth (src/http/auth.ts) — every outcome here is "who are you", never
  // "what are you allowed to do" (that's the 403s under Runtime/
  // Permissions above), so all three are 401, not 403.
  [ErrorCode.AUTH_KEY_MISSING]: 401,
  [ErrorCode.AUTH_KEY_INVALID]: 401,
  [ErrorCode.AUTH_KEY_REVOKED]: 401,
};

const DEFAULT_STATUS = 500;

/** Stable, minimal JSON error shape every failing response uses — never the raw `XoError`/`Error` object. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly context?: Readonly<Record<string, unknown>>;
  };
}

function toBody(code: string, message: string, context?: Readonly<Record<string, unknown>>): ApiErrorBody {
  const hasContext = context !== undefined && Object.keys(context).length > 0;
  return { error: hasContext ? { code, message, context } : { code, message } };
}

/**
 * Maps any error a route handler surfaces to an `ApiResponse`. Accepts
 * `unknown` deliberately — a route's own `Result` failure is always a
 * `XoError`, but this is also the last line of defense around an
 * unexpected `throw` (see `server.ts`'s top-level catch), which is
 * never guaranteed to be an `XoError`.
 */
export function errorToResponse(error: unknown): ApiResponse {
  if (error instanceof XoError) {
    const status = STATUS_BY_CODE[error.code] ?? DEFAULT_STATUS;
    return { status, body: toBody(error.code, error.message, error.context) };
  }
  if (error instanceof Error) {
    // Never leak an arbitrary thrown Error's message/stack verbatim —
    // it wasn't constructed as an API-facing value.
    return { status: DEFAULT_STATUS, body: toBody(ErrorCode.UNKNOWN, 'an unexpected error occurred') };
  }
  return { status: DEFAULT_STATUS, body: toBody(ErrorCode.UNKNOWN, 'an unexpected error occurred') };
}

/** Exported for the completeness test — not used by route code. */
export function knownStatusCodes(): Readonly<Record<string, number>> {
  return STATUS_BY_CODE;
}
