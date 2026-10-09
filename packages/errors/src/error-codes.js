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
};
//# sourceMappingURL=error-codes.js.map