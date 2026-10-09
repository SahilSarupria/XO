import { XoError } from './base-error.js';
import { ErrorCode } from './error-codes.js';
export class NotFoundError extends XoError {
    constructor(subject, options) {
        super(ErrorCode.NOT_FOUND, `${subject} was not found`, options);
    }
}
export class InvalidArgumentError extends XoError {
    constructor(message, options) {
        super(ErrorCode.INVALID_ARGUMENT, message, options);
    }
}
export class UnimplementedError extends XoError {
    constructor(what, options) {
        super(ErrorCode.UNIMPLEMENTED, `${what} is not implemented in this module`, options);
    }
}
export class ConfigError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class SerializationError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class CryptoError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class StorageError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
/** Structural/content problems with a package itself — a bad manifest, a corrupt archive, a missing component, an invalid version. Raised while building, reading, or validating a package, independent of whether it's ever installed anywhere. */
export class PackageError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class DependencyError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
/** Problems specific to local install-state management — installing, upgrading, rolling back, or uninstalling an already-valid package. Distinct from {@link PackageError}: a package can be perfectly well-formed and still fail to install (e.g. it's already installed, or the requested upgrade isn't a valid version bump). */
export class InstallError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
/** Runtime Stage 1 (package mounting & execution pipeline) errors — mounting/unmounting a package, resolving a capability, or planning an execution. Distinct from {@link InstallError}: install state lives in @xo/package-sdk and is a precondition for mounting, not something the runtime itself manages. */
export class RuntimeError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class DiError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class XoirError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
export class PdfError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
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
export class SourceError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
/** Raised by `@xo/ai-core`'s `AiCapabilityLayer` and its internal routing machinery (retry, circuit-breaking, rate-limiting, prompt lookup, schema validation, and per-provider request failures) — the class name is `AiError` (not e.g. `AiProviderError`) because failures here aren't only ever a single provider's fault: `AI_ALL_PROVIDERS_FAILED`/`AI_NO_ELIGIBLE_PROVIDER` are routing-level outcomes across every candidate provider, not one provider's error. */
export class AiError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
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
export class PermissionError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
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
export class AuthError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
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
export class CapabilityContractError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
/** Raised by `@xo/registry`'s repository implementations and `RegistryClient` — an unverified/tampered package rejected at publish time, a duplicate publish/benchmark/license record, an invalid royalty split, or ledger tamper-detection. Never used for an ordinary "not found" (see `@xo/errors`' `NotFoundError`, which every `registry-core` `get()` method already returns). */
export class RegistryError extends XoError {
    constructor(code, message, options) {
        super(code, message, options);
    }
}
//# sourceMappingURL=domain-errors.js.map