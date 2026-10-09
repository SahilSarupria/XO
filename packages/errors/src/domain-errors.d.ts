import { XoError, type XoErrorOptions } from './base-error.js';
import { ErrorCode } from './error-codes.js';
export declare class NotFoundError extends XoError {
    constructor(subject: string, options?: XoErrorOptions);
}
export declare class InvalidArgumentError extends XoError {
    constructor(message: string, options?: XoErrorOptions);
}
export declare class UnimplementedError extends XoError {
    constructor(what: string, options?: XoErrorOptions);
}
export declare class ConfigError extends XoError {
    constructor(code: typeof ErrorCode.CONFIG_MISSING_KEY | typeof ErrorCode.CONFIG_INVALID_VALUE, message: string, options?: XoErrorOptions);
}
export declare class SerializationError extends XoError {
    constructor(code: typeof ErrorCode.SERIALIZATION_SCHEMA_MISMATCH | typeof ErrorCode.SERIALIZATION_PARSE_FAILED, message: string, options?: XoErrorOptions);
}
export declare class CryptoError extends XoError {
    constructor(code: typeof ErrorCode.CRYPTO_HASH_MISMATCH | typeof ErrorCode.CRYPTO_SIGNATURE_INVALID | typeof ErrorCode.CRYPTO_KEY_NOT_FOUND, message: string, options?: XoErrorOptions);
}
export declare class StorageError extends XoError {
    constructor(code: typeof ErrorCode.STORAGE_OBJECT_NOT_FOUND | typeof ErrorCode.STORAGE_WRITE_FAILED, message: string, options?: XoErrorOptions);
}
/** Structural/content problems with a package itself — a bad manifest, a corrupt archive, a missing component, an invalid version. Raised while building, reading, or validating a package, independent of whether it's ever installed anywhere. */
export declare class PackageError extends XoError {
    constructor(code: typeof ErrorCode.PACKAGE_MANIFEST_INVALID | typeof ErrorCode.PACKAGE_VERSION_INVALID | typeof ErrorCode.PACKAGE_CORRUPT | typeof ErrorCode.PACKAGE_COMPONENT_MISSING | typeof ErrorCode.CRYPTO_SIGNATURE_INVALID, message: string, options?: XoErrorOptions);
}
export declare class DependencyError extends XoError {
    constructor(code: typeof ErrorCode.PACKAGE_DEPENDENCY_CYCLE | typeof ErrorCode.PACKAGE_DEPENDENCY_CONFLICT | typeof ErrorCode.PACKAGE_DEPENDENCY_UNRESOLVED | typeof ErrorCode.PACKAGE_LOCKFILE_INVALID | typeof ErrorCode.PACKAGE_LOCKFILE_STALE, message: string, options?: XoErrorOptions);
}
/** Problems specific to local install-state management — installing, upgrading, rolling back, or uninstalling an already-valid package. Distinct from {@link PackageError}: a package can be perfectly well-formed and still fail to install (e.g. it's already installed, or the requested upgrade isn't a valid version bump). */
export declare class InstallError extends XoError {
    constructor(code: typeof ErrorCode.PACKAGE_VALIDATION_FAILED | typeof ErrorCode.PACKAGE_ALREADY_INSTALLED | typeof ErrorCode.PACKAGE_NOT_INSTALLED | typeof ErrorCode.PACKAGE_UPGRADE_INVALID, message: string, options?: XoErrorOptions);
}
/** Runtime Stage 1 (package mounting & execution pipeline) errors — mounting/unmounting a package, resolving a capability, or planning an execution. Distinct from {@link InstallError}: install state lives in @xo/package-sdk and is a precondition for mounting, not something the runtime itself manages. */
export declare class RuntimeError extends XoError {
    constructor(code: typeof ErrorCode.RUNTIME_MOUNT_FAILED | typeof ErrorCode.RUNTIME_ALREADY_MOUNTED | typeof ErrorCode.RUNTIME_NOT_MOUNTED | typeof ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND | typeof ErrorCode.RUNTIME_NO_COMPATIBLE_PACKAGE | typeof ErrorCode.RUNTIME_PLAN_FAILED | typeof ErrorCode.RUNTIME_SESSION_INVALID_STATE | typeof ErrorCode.RUNTIME_INVALID_REQUEST | typeof ErrorCode.RUNTIME_RETRIEVAL_FAILED | typeof ErrorCode.RUNTIME_SAFETY_BLOCKED | typeof ErrorCode.RUNTIME_BUDGET_EXCEEDED | typeof ErrorCode.RUNTIME_EXECUTION_FAILED | typeof ErrorCode.RUNTIME_EXECUTION_TIMEOUT | typeof ErrorCode.RUNTIME_EXECUTION_CANCELLED | typeof ErrorCode.RUNTIME_PERMISSION_DENIED | typeof ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID | typeof ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, message: string, options?: XoErrorOptions);
}
export declare class DiError extends XoError {
    constructor(code: typeof ErrorCode.DI_TOKEN_NOT_REGISTERED | typeof ErrorCode.DI_CIRCULAR_DEPENDENCY, message: string, options?: XoErrorOptions);
}
export declare class XoirError extends XoError {
    constructor(code: typeof ErrorCode.XOIR_DUPLICATE_NODE | typeof ErrorCode.XOIR_DUPLICATE_EDGE | typeof ErrorCode.XOIR_DANGLING_EDGE | typeof ErrorCode.XOIR_CYCLE_DETECTED | typeof ErrorCode.XOIR_HASH_MISMATCH | typeof ErrorCode.XOIR_VALIDATION_FAILED | typeof ErrorCode.XOIR_MERGE_CONFLICT | typeof ErrorCode.XOIR_SCHEMA_VERSION_UNSUPPORTED | typeof ErrorCode.XOIR_PASS_FAILED | typeof ErrorCode.XOIR_PASS_CANCELLED, message: string, options?: XoErrorOptions);
}
export declare class PdfError extends XoError {
    constructor(code: typeof ErrorCode.PDF_MALFORMED | typeof ErrorCode.PDF_UNSUPPORTED_FEATURE | typeof ErrorCode.PDF_ENCRYPTED, message: string, options?: XoErrorOptions);
}
/**
 * Raised by `@xo/compiler`'s source-ingestion boundary (Stage 8) — a
 * `SourceFrontend` that can't parse/validate the input it was asked to
 * ingest, a `SourceFrontendRegistry` that can't find (or already has) a
 * frontend for a given source type, or a caller asking for semantic
 * content a source legitimately doesn't have available (e.g. an image
 * with no vision/OCR processor wired up). Never used for an ordinary
 * "this source produced zero extractable units" outcome, which is a
 * valid, non-error `CanonicalSource` with `semanticExtractionAvailable:
 * false` or an empty `ExperienceDocument`, not a thrown/`Result`-err
 * failure.
 *
 * Deliberately reuses this package's existing generic `ErrorCode`
 * members (`NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`,
 * `PRECONDITION_FAILED`, `SERIALIZATION_PARSE_FAILED`,
 * `SERIALIZATION_SCHEMA_MISMATCH`) rather than minting new `SOURCE_*`
 * codes: `apps/api`'s HTTP error-mapping layer enumerates every
 * `ErrorCode` value and fails its own completeness test if a new code is
 * added without a corresponding status mapping there, and `apps/api` is
 * out of scope for this change. The specific, source-ingestion-flavored
 * meaning still comes through in each `SourceError`'s `message` and
 * `context` — the `code` says *which general kind* of failure this is
 * (not found / already exists / bad input / precondition unmet / parse
 * failed / shape mismatch), exactly as every other caller of these
 * generic codes elsewhere in the platform already does.
 */
export declare class SourceError extends XoError {
    constructor(code: typeof ErrorCode.NOT_FOUND | typeof ErrorCode.ALREADY_EXISTS | typeof ErrorCode.INVALID_ARGUMENT | typeof ErrorCode.PRECONDITION_FAILED | typeof ErrorCode.SERIALIZATION_PARSE_FAILED | typeof ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, message: string, options?: XoErrorOptions);
}
/** Raised by `@xo/ai-core`'s `AiCapabilityLayer` and its internal routing machinery (retry, circuit-breaking, rate-limiting, prompt lookup, schema validation, and per-provider request failures) — the class name is `AiError` (not e.g. `AiProviderError`) because failures here aren't only ever a single provider's fault: `AI_ALL_PROVIDERS_FAILED`/`AI_NO_ELIGIBLE_PROVIDER` are routing-level outcomes across every candidate provider, not one provider's error. */
export declare class AiError extends XoError {
    constructor(code: typeof ErrorCode.AI_SCHEMA_VALIDATION_FAILED | typeof ErrorCode.AI_RATE_LIMITED | typeof ErrorCode.AI_CIRCUIT_OPEN | typeof ErrorCode.AI_NO_ELIGIBLE_PROVIDER | typeof ErrorCode.AI_ALL_PROVIDERS_FAILED | typeof ErrorCode.AI_PROMPT_NOT_FOUND | typeof ErrorCode.AI_PROVIDER_REQUEST_FAILED | typeof ErrorCode.AI_REPLAY_FIXTURE_MISSING, message: string, options?: XoErrorOptions);
}
/**
 * Infrastructure / programmer-error failures from `@xo/permissions` — a
 * malformed request the manager fail-closes on, a policy configuration
 * error, or a `PermissionStore` backend failure. Never used for an
 * ordinary allow/deny/prompt outcome, which is always a `PermissionDecision`
 * value returned from `check`/`request`, not a thrown or `Result`-wrapped
 * error — see `@xo/permissions`' README for why decisions and errors are
 * kept separate.
 */
export declare class PermissionError extends XoError {
    constructor(code: typeof ErrorCode.PERMISSION_INVALID_REQUEST | typeof ErrorCode.PERMISSION_STORE_ERROR | typeof ErrorCode.PERMISSION_POLICY_INVALID, message: string, options?: XoErrorOptions);
}
/**
 * Raised by `apps/api`'s API-key authentication middleware
 * (`src/http/auth.ts`) — a request presented no credential, an
 * unrecognized credential, or a credential that once worked but was
 * revoked. Never used for an authorization outcome ("this identity isn't
 * allowed to do X") — that's `@xo/permissions`' `PermissionDecision`,
 * not a thrown error; this class only ever answers "who is this caller",
 * per the auth/permissions boundary documented in `apps/api/README.md`.
 */
export declare class AuthError extends XoError {
    constructor(code: typeof ErrorCode.AUTH_KEY_MISSING | typeof ErrorCode.AUTH_KEY_INVALID | typeof ErrorCode.AUTH_KEY_REVOKED, message: string, options?: XoErrorOptions);
}
/**
 * Raised by `@xo/capability-contract` — building a `SemanticCapabilityContract`
 * from a XOIR graph (`CONTRACT_SOURCE_NODE_NOT_FOUND`/`CONTRACT_SOURCE_NODE_INVALID`/
 * `CONTRACT_MALFORMED`), or resolving one to an executable binding
 * (`BINDING_UNRESOLVED`/`BINDING_AMBIGUOUS`/`BINDING_DENIED`). Deliberately
 * distinct from `RuntimeError`'s `RUNTIME_CAPABILITY_*` codes: those describe
 * failures at the execution-authority boundary (`@xo/runtime`'s
 * `RuntimeCapabilityRegistry`/`RuntimeCapabilityExecutor`), after a binding has
 * already been resolved and registered; this class describes failures upstream
 * of that, while a semantic capability is still only a *candidate* for
 * execution, not yet an executable one.
 */
export declare class CapabilityContractError extends XoError {
    constructor(code: typeof ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND | typeof ErrorCode.CONTRACT_SOURCE_NODE_INVALID | typeof ErrorCode.CONTRACT_MALFORMED | typeof ErrorCode.BINDING_UNRESOLVED | typeof ErrorCode.BINDING_AMBIGUOUS | typeof ErrorCode.BINDING_DENIED, message: string, options?: XoErrorOptions);
}
/** Raised by `@xo/registry`'s repository implementations and `RegistryClient` — an unverified/tampered package rejected at publish time, a duplicate publish/benchmark/license record, an invalid royalty split, or ledger tamper-detection. Never used for an ordinary "not found" (see `@xo/errors`' `NotFoundError`, which every `registry-core` `get()` method already returns). */
export declare class RegistryError extends XoError {
    constructor(code: typeof ErrorCode.REGISTRY_PACKAGE_UNVERIFIED | typeof ErrorCode.REGISTRY_PACKAGE_ALREADY_PUBLISHED | typeof ErrorCode.REGISTRY_BENCHMARK_ALREADY_RECORDED | typeof ErrorCode.REGISTRY_ROYALTY_SPLIT_INVALID | typeof ErrorCode.REGISTRY_LICENSE_ALREADY_EXISTS | typeof ErrorCode.REGISTRY_LEDGER_TAMPERED | typeof ErrorCode.REGISTRY_LEDGER_ENTRY_NOT_FOUND, message: string, options?: XoErrorOptions);
}
//# sourceMappingURL=domain-errors.d.ts.map