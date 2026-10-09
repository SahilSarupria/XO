/**
 * Stable error codes. These are part of the platform's public contract:
 * SDK consumers and CLI scripts may match on `error.code`, so codes are
 * append-only — never renumber, never repurpose an existing string.
 */
export const ErrorCode = {
  // Generic / cross-cutting
  UNKNOWN: 'XO_UNKNOWN',
  INVALID_ARGUMENT: 'XO_INVALID_ARGUMENT',
  NOT_FOUND: 'XO_NOT_FOUND',
  ALREADY_EXISTS: 'XO_ALREADY_EXISTS',
  PRECONDITION_FAILED: 'XO_PRECONDITION_FAILED',
  UNIMPLEMENTED: 'XO_UNIMPLEMENTED',
  IO_ERROR: 'XO_IO_ERROR',

  // Configuration
  CONFIG_MISSING_KEY: 'XO_CONFIG_MISSING_KEY',
  CONFIG_INVALID_VALUE: 'XO_CONFIG_INVALID_VALUE',

  // Serialization
  SERIALIZATION_SCHEMA_MISMATCH: 'XO_SERIALIZATION_SCHEMA_MISMATCH',
  SERIALIZATION_PARSE_FAILED: 'XO_SERIALIZATION_PARSE_FAILED',

  // Crypto
  CRYPTO_HASH_MISMATCH: 'XO_CRYPTO_HASH_MISMATCH',
  CRYPTO_SIGNATURE_INVALID: 'XO_CRYPTO_SIGNATURE_INVALID',
  CRYPTO_KEY_NOT_FOUND: 'XO_CRYPTO_KEY_NOT_FOUND',

  // Storage
  STORAGE_OBJECT_NOT_FOUND: 'XO_STORAGE_OBJECT_NOT_FOUND',
  STORAGE_WRITE_FAILED: 'XO_STORAGE_WRITE_FAILED',

  // Dependency injection
  DI_TOKEN_NOT_REGISTERED: 'XO_DI_TOKEN_NOT_REGISTERED',
  DI_CIRCULAR_DEPENDENCY: 'XO_DI_CIRCULAR_DEPENDENCY',

  // Packages (@xo/package-sdk) — building, validating, signing, packing,
  // installing, and diffing .xo packages (SPECIFICATION.md §1)
  PACKAGE_MANIFEST_INVALID: 'XO_PACKAGE_MANIFEST_INVALID',
  PACKAGE_VERSION_INVALID: 'XO_PACKAGE_VERSION_INVALID',
  PACKAGE_CORRUPT: 'XO_PACKAGE_CORRUPT',
  PACKAGE_COMPONENT_MISSING: 'XO_PACKAGE_COMPONENT_MISSING',
  PACKAGE_VALIDATION_FAILED: 'XO_PACKAGE_VALIDATION_FAILED',
  PACKAGE_ALREADY_INSTALLED: 'XO_PACKAGE_ALREADY_INSTALLED',
  PACKAGE_NOT_INSTALLED: 'XO_PACKAGE_NOT_INSTALLED',
  PACKAGE_UPGRADE_INVALID: 'XO_PACKAGE_UPGRADE_INVALID',

  // Package dependency resolution
  PACKAGE_DEPENDENCY_CYCLE: 'XO_PACKAGE_DEPENDENCY_CYCLE',
  PACKAGE_DEPENDENCY_CONFLICT: 'XO_PACKAGE_DEPENDENCY_CONFLICT',
  PACKAGE_DEPENDENCY_UNRESOLVED: 'XO_PACKAGE_DEPENDENCY_UNRESOLVED',
  PACKAGE_LOCKFILE_INVALID: 'XO_PACKAGE_LOCKFILE_INVALID',
  PACKAGE_LOCKFILE_STALE: 'XO_PACKAGE_LOCKFILE_STALE',

  // Runtime (@xo/runtime) — package mounting & execution pipeline
  // (Runtime Stage 1)
  RUNTIME_MOUNT_FAILED: 'XO_RUNTIME_MOUNT_FAILED',
  RUNTIME_ALREADY_MOUNTED: 'XO_RUNTIME_ALREADY_MOUNTED',
  RUNTIME_NOT_MOUNTED: 'XO_RUNTIME_NOT_MOUNTED',
  RUNTIME_CAPABILITY_NOT_FOUND: 'XO_RUNTIME_CAPABILITY_NOT_FOUND',
  RUNTIME_NO_COMPATIBLE_PACKAGE: 'XO_RUNTIME_NO_COMPATIBLE_PACKAGE',
  RUNTIME_PLAN_FAILED: 'XO_RUNTIME_PLAN_FAILED',
  RUNTIME_SESSION_INVALID_STATE: 'XO_RUNTIME_SESSION_INVALID_STATE',
  // Runtime Stage 2 — execution pipeline (retrieval through AI call)
  RUNTIME_INVALID_REQUEST: 'XO_RUNTIME_INVALID_REQUEST',
  RUNTIME_RETRIEVAL_FAILED: 'XO_RUNTIME_RETRIEVAL_FAILED',
  RUNTIME_SAFETY_BLOCKED: 'XO_RUNTIME_SAFETY_BLOCKED',
  RUNTIME_BUDGET_EXCEEDED: 'XO_RUNTIME_BUDGET_EXCEEDED',
  RUNTIME_EXECUTION_FAILED: 'XO_RUNTIME_EXECUTION_FAILED',
  RUNTIME_EXECUTION_TIMEOUT: 'XO_RUNTIME_EXECUTION_TIMEOUT',
  RUNTIME_EXECUTION_CANCELLED: 'XO_RUNTIME_EXECUTION_CANCELLED',
  // Runtime Stage 2 — permission gate (see @xo/permissions). Raised when a
  // configured PermissionGate denies a capability execution before it
  // reaches the AI Capability Layer.
  RUNTIME_PERMISSION_DENIED: 'XO_RUNTIME_PERMISSION_DENIED',
  // Runtime Stage 2 — confidence gate (R3). Raised when a planned
  // capability's declared `confidence.score` is below a configured
  // `ExecutionPipelineOptions.minConfidence` floor. Deliberately its own
  // code, distinct from RUNTIME_PERMISSION_DENIED — confidence and
  // authorization are independent gates and a caller should be able to
  // tell which one denied a request without parsing the message string.
  RUNTIME_CONFIDENCE_BELOW_THRESHOLD: 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD',
  // Runtime Stage 2 — R1/R2 closure. Raised when a planned capability's
  // `CapabilityDeclaration.execution.mode` is 'deterministic_rule' but no
  // `capabilityAuthorityExecutor` was configured on the pipeline to
  // actually run it — a deterministic-rule capability must never
  // silently fall through to the AI-provider path, so this is a hard,
  // fail-closed misconfiguration error, not a fallback trigger.
  RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED: 'XO_RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED',
  // Runtime Stage 2 — R2 closure. Raised when a deterministic-rule
  // capability's declared `execution.inputSchema` rejects the request's
  // `structuredInput` before the underlying binding is ever evaluated.
  RUNTIME_CAPABILITY_INPUT_INVALID: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
  // Runtime Stage 2 — R4 closure. Raised when `ExecutionStrategyRouter`
  // is asked to resolve a `CapabilityDeclaration.execution.mode` value
  // outside the two currently-registered strategies ('deterministic_rule',
  // 'model'). Unreachable via the current closed `CapabilityExecutionMode`
  // union from normal TypeScript-checked code; exists so that a future,
  // wider `execution.mode` value emitted by a newer compiler can never
  // silently execute against an older runtime's AI-provider path just
  // because it fell through an unrecognized branch — same fail-closed
  // reasoning as RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED above,
  // generalized from "known mode, missing executor" to "mode not known
  // at all".
  RUNTIME_UNSUPPORTED_EXECUTION_MODE: 'XO_RUNTIME_UNSUPPORTED_EXECUTION_MODE',
  // Runtime capability authority layer (native/host-registered capability
  // execution, distinct from the manifest-declared/AI-provider path
  // above). A capability whose declaration fails registration-time
  // validation, or whose registered handler throws/is missing at
  // execution time — both distinct, deterministic failures from "unknown
  // capability id" (RUNTIME_CAPABILITY_NOT_FOUND, reused above) and from
  // a permission denial (RUNTIME_PERMISSION_DENIED, reused above).
  RUNTIME_CAPABILITY_DECLARATION_INVALID: 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID',
  RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE: 'XO_RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE',

  // Capability contract & binding (@xo/capability-contract) — projecting a
  // compiled XOIR capability node into a SemanticCapabilityContract, and
  // resolving that contract to an executable implementation. Deliberately
  // its own small code family, distinct from RUNTIME_CAPABILITY_* above:
  // these failures happen before a RuntimeCapabilityDeclaration is ever
  // registered, at the semantic-discovery/resolution layer, not at the
  // execution-authority layer.
  CONTRACT_SOURCE_NODE_NOT_FOUND: 'XO_CONTRACT_SOURCE_NODE_NOT_FOUND',
  CONTRACT_SOURCE_NODE_INVALID: 'XO_CONTRACT_SOURCE_NODE_INVALID',
  CONTRACT_MALFORMED: 'XO_CONTRACT_MALFORMED',
  BINDING_UNRESOLVED: 'XO_BINDING_UNRESOLVED',
  BINDING_AMBIGUOUS: 'XO_BINDING_AMBIGUOUS',
  BINDING_DENIED: 'XO_BINDING_DENIED',

  // XOIR (Experience Object Intermediate Representation)
  XOIR_DUPLICATE_NODE: 'XO_XOIR_DUPLICATE_NODE',
  XOIR_DUPLICATE_EDGE: 'XO_XOIR_DUPLICATE_EDGE',
  XOIR_DANGLING_EDGE: 'XO_XOIR_DANGLING_EDGE',
  XOIR_CYCLE_DETECTED: 'XO_XOIR_CYCLE_DETECTED',
  XOIR_HASH_MISMATCH: 'XO_XOIR_HASH_MISMATCH',
  XOIR_VALIDATION_FAILED: 'XO_XOIR_VALIDATION_FAILED',
  XOIR_MERGE_CONFLICT: 'XO_XOIR_MERGE_CONFLICT',
  XOIR_SCHEMA_VERSION_UNSUPPORTED: 'XO_XOIR_SCHEMA_VERSION_UNSUPPORTED',
  XOIR_PASS_FAILED: 'XO_XOIR_PASS_FAILED',
  XOIR_PASS_CANCELLED: 'XO_XOIR_PASS_CANCELLED',

  // Compiler frontend — PDF loading
  PDF_MALFORMED: 'XO_PDF_MALFORMED',
  PDF_UNSUPPORTED_FEATURE: 'XO_PDF_UNSUPPORTED_FEATURE',
  PDF_ENCRYPTED: 'XO_PDF_ENCRYPTED',

  // AI Capability Layer
  AI_PROVIDER_REQUEST_FAILED: 'XO_AI_PROVIDER_REQUEST_FAILED',
  AI_ALL_PROVIDERS_FAILED: 'XO_AI_ALL_PROVIDERS_FAILED',
  AI_NO_ELIGIBLE_PROVIDER: 'XO_AI_NO_ELIGIBLE_PROVIDER',
  AI_RATE_LIMITED: 'XO_AI_RATE_LIMITED',
  AI_CIRCUIT_OPEN: 'XO_AI_CIRCUIT_OPEN',
  AI_SCHEMA_VALIDATION_FAILED: 'XO_AI_SCHEMA_VALIDATION_FAILED',
  AI_PROMPT_NOT_FOUND: 'XO_AI_PROMPT_NOT_FOUND',
  AI_REPLAY_FIXTURE_MISSING: 'XO_AI_REPLAY_FIXTURE_MISSING',

  // Permissions (@xo/permissions) — the security/policy layer between a
  // package's declared capabilities and actual runtime execution. See
  // that package's README for the full model; codes here are for
  // programmer-error / infrastructure failures only (an ordinary
  // allow/deny/prompt outcome is a `PermissionDecision` value, never a
  // thrown error — see @xo/permissions' "Result vs. decision" note).
  PERMISSION_INVALID_REQUEST: 'XO_PERMISSION_INVALID_REQUEST',
  PERMISSION_STORE_ERROR: 'XO_PERMISSION_STORE_ERROR',
  PERMISSION_POLICY_INVALID: 'XO_PERMISSION_POLICY_INVALID',

  // Registry (@xo/registry) — PackageRepository/BenchmarkRepository/
  // LicenseRepository/Ledger implementations and the RegistryClient facade
  REGISTRY_PACKAGE_UNVERIFIED: 'XO_REGISTRY_PACKAGE_UNVERIFIED',
  REGISTRY_PACKAGE_ALREADY_PUBLISHED: 'XO_REGISTRY_PACKAGE_ALREADY_PUBLISHED',
  REGISTRY_BENCHMARK_ALREADY_RECORDED: 'XO_REGISTRY_BENCHMARK_ALREADY_RECORDED',
  REGISTRY_ROYALTY_SPLIT_INVALID: 'XO_REGISTRY_ROYALTY_SPLIT_INVALID',
  REGISTRY_LICENSE_ALREADY_EXISTS: 'XO_REGISTRY_LICENSE_ALREADY_EXISTS',
  REGISTRY_LEDGER_TAMPERED: 'XO_REGISTRY_LEDGER_TAMPERED',
  REGISTRY_LEDGER_ENTRY_NOT_FOUND: 'XO_REGISTRY_LEDGER_ENTRY_NOT_FOUND',

  // Auth (apps/api's API-key authentication seam, src/http/auth.ts) — who
  // is calling, not what they're allowed to do (see @xo/permissions for
  // the latter). A missing/unknown/revoked key are three distinct
  // caller-facing outcomes, all 401s, kept as separate codes so a client
  // can tell "you sent nothing" from "that key doesn't exist" from "that
  // key used to work" without parsing the message string.
  AUTH_KEY_MISSING: 'XO_AUTH_KEY_MISSING',
  AUTH_KEY_INVALID: 'XO_AUTH_KEY_INVALID',
  AUTH_KEY_REVOKED: 'XO_AUTH_KEY_REVOKED',

  // Runtime R6 — production execution semantics (retry, simulation,
  // replay, in-flight dedup). Deliberately its own small, append-only
  // family layered on top of the Stage 2/R1-R5 RUNTIME_* codes above,
  // never repurposing or removing any of them — an R6 failure is always
  // still reachable via the underlying RuntimeError it wraps/reports
  // alongside (see each code's own doc comment at its raise site) so a
  // consumer matching only on legacy codes is unaffected.
  //
  // Retry exhausted: every attempt failed with a retryable-classified
  // error and no attempts remain. Distinct from RUNTIME_EXECUTION_FAILED
  // (a single, non-retried failure) so a caller can tell "failed once"
  // from "failed after N attempts" without inspecting attempt counts.
  RUNTIME_RETRY_EXHAUSTED: 'XO_RUNTIME_RETRY_EXHAUSTED',
  // Simulation requested (ExecutionRequest.simulate === true) for a
  // strategy this runtime cannot honestly simulate without either
  // fabricating output or risking a real side effect — currently
  // 'deterministic_rule' unconditionally, and 'hybrid' whenever any
  // declared step is 'deterministic_rule'. Fails closed before any
  // handler/provider call is made.
  RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY: 'XO_RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY',
  // A second ExecutionEngine.execute/executeWithCancellation call for a
  // RequestId (== ExecutionId, per deriveExecutionId) that already has
  // an in-flight attempt on the same engine instance. Execution-
  // bookkeeping idempotency only — see ExecutionEngine's doc comment for
  // the explicit, deliberate boundary of what this does and does not
  // guarantee.
  RUNTIME_EXECUTION_ALREADY_IN_FLIGHT: 'XO_RUNTIME_EXECUTION_ALREADY_IN_FLIGHT',
  // Replay requested for a receipt whose recorded inputs, or whose
  // original capability-authority contractId/bindingId, are not
  // available to reconstruct from — replay fails closed rather than
  // guessing at a substitute source.
  RUNTIME_REPLAY_SOURCE_UNAVAILABLE: 'XO_RUNTIME_REPLAY_SOURCE_UNAVAILABLE',
  // A human decision was recorded for a `human_in_the_loop` execution
  // (the decision itself is real, persisted work — see
  // `apps/api/src/executions/execution.ts`'s `HumanTaskInfo`), but no
  // runtime resume primitive exists yet for the execution path that
  // produced it: `ActionEscalationBindingResolver`'s `evaluate` is a
  // pure, stateless function with no continuation to resume (see that
  // resolver's own doc comment — "whether the human actually completes
  // the action is outside this binding's scope entirely"), and
  // `WorkflowExecutor.resume`'s checkpoint mechanism only applies to a
  // full workflow-graph execution, which a direct
  // `RuntimeCapabilityExecutor.execute` call (the path a single-
  // capability execution actually uses) never creates. This code
  // distinguishes "we honestly can't resume this yet" from
  // `RUNTIME_EXECUTION_FAILED` (a real attempted execution that failed)
  // or any BINDING_* code (a capability that never resolved to a
  // binding at all) — a resume attempt on a `human_in_the_loop`
  // execution reaches neither of those; it simply has nothing to invoke.
  HITL_RESUME_UNSUPPORTED: 'XO_HITL_RESUME_UNSUPPORTED',

  // P0.8 — persistent workflow execution. A workflow that exists (it was
  // composed from a stored compilation) but that the existing
  // `@xo/workflow-composer` executability audit does not classify as
  // `executable_candidate`: `not_executable_yet` (missing/unbound
  // strategy evidence, ambiguous precedence, ...) or
  // `semantically_invalid` (cycle, conflict, unresolved declared
  // dependency), or one whose steps cannot all be bound to an
  // executable capability at start time. Deliberately NOT used for
  // authentication, ownership, request-validation, or storage failures —
  // those keep their existing codes.
  WORKFLOW_NOT_EXECUTABLE: 'XO_WORKFLOW_NOT_EXECUTABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
