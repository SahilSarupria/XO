import type { PermissionScope, Principal } from '@xo/permissions';
import type { Result } from '@xo/types';
import type { AuthorizationPort } from './authorization.js';
import type { DiscoveryError } from './errors.js';
import type { Evidence, EvidenceKind } from './evidence.js';
import type { ConnectorId, SourceId } from './ids.js';

/** Time is injected, never read from a global (docs/CODING_STANDARDS.md). Structurally satisfied by `@xo/testing`'s `MockClock`. */
export interface Clock {
  now(): Date;
}

/** Open set: first milestone implements only `local_filesystem`. Custom connectors use `x-<org>-<name>`. */
export type SourceType = 'local_filesystem' | 'saas_application' | 'database' | 'api' | 'admin_inventory' | `x-${string}`;

/** Every operation a connector may offer. Support is declared per operation, never assumed. */
export type ConnectorOperation = 'detect' | 'validate_connection' | 'discover' | 'acquire_content' | 'incremental_sync' | 'health';

export type OperationSupport = 'supported' | 'unsupported';

export type AuthMethod = 'none' | 'operator_scope_grant' | 'oauth2' | 'api_key' | 'service_account' | 'database_credentials';

export interface ConfigFieldSpec {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** Secrets are never accepted as plain config; they must come through an approved secret mechanism (not implemented here). */
  readonly secret: boolean;
}

/**
 * Self-description every connector must publish. This is the "discovery
 * adapter documentation" requirement made machine-readable: scope,
 * privileges, what it can and cannot see, and whether it mutates anything.
 */
export interface ConnectorDescriptor {
  readonly id: ConnectorId;
  readonly version: string;
  readonly displayName: string;
  readonly sourceTypes: readonly SourceType[];
  readonly authMethods: readonly AuthMethod[];
  readonly configFields: readonly ConfigFieldSpec[];
  /** Permissions (platform `domain.action` vocabulary) the connector will request, per operation. */
  readonly requiredPermissions: Readonly<Partial<Record<ConnectorOperation, string>>>;
  readonly operations: Readonly<Record<ConnectorOperation, OperationSupport>>;
  readonly evidenceKinds: readonly EvidenceKind[];
  /** Literal `'none'` in v1: the contract has no way to express a connector that mutates its source. */
  readonly sideEffects: 'none';
  readonly documentation: {
    readonly scope: string;
    readonly detects: readonly string[];
    readonly cannotDetermine: readonly string[];
    readonly limitations: readonly string[];
  };
}

export interface ConnectorContext {
  readonly clock: Clock;
  readonly authorization: AuthorizationPort;
  /** Cooperative cancellation. Connectors check it between units of work and return partial results. */
  readonly signal?: AbortSignal;
  readonly principal?: Principal;
}

/** A system/location that was found to exist. Existence only — says nothing about permission to read it. */
export interface DetectedSource {
  readonly sourceId: SourceId;
  readonly sourceType: SourceType;
  readonly displayName: string;
  /** Where the source is (for a filesystem: the approved root). Metadata; not a credential. */
  readonly locator: string;
  readonly detectedBy: ConnectorId;
  readonly detectedAt: string;
  /** Digest of the source's IDENTITY only (what makes it this source). Constant across scans; content change is tracked separately by {@link ScanFingerprint}. */
  readonly fingerprint: string;
}

export interface DiscoveryScopeBase {
  readonly kind: string;
}

export interface DiscoveryRequest<TScope extends DiscoveryScopeBase = DiscoveryScopeBase> {
  readonly sourceType: SourceType;
  readonly scope: TScope;
}

export interface SkippedSummary {
  /** Counts only. Names of skipped/excluded entries are deliberately not retained (data minimization). */
  readonly byReason: Readonly<Record<string, number>>;
}

export interface LimitReport {
  readonly hit: readonly string[];
  readonly entriesVisited: number;
  readonly elapsedMs: number;
}

export type OutcomeStatus = 'complete' | 'partial';

/** Digest of everything a discovery pass observed inside one source. Equal digests across passes mean "unchanged". */
export interface ScanFingerprint {
  readonly sourceId: SourceId;
  readonly contentFingerprint: string;
}

export interface DiscoveryOutcome {
  readonly status: OutcomeStatus;
  readonly sources: readonly DetectedSource[];
  readonly scans: readonly ScanFingerprint[];
  readonly evidence: readonly Evidence[];
  readonly skipped: SkippedSummary;
  readonly limits: LimitReport;
  /** Non-fatal, per-entry problems. A fatal problem is a `Result.err`, not an entry here. */
  readonly errors: readonly DiscoveryError[];
}

export interface AcquisitionRequest {
  readonly sourceId: SourceId;
  readonly kind: EvidenceKind;
  /** Source-relative resource keys to acquire. */
  readonly resourceKeys: readonly string[];
  readonly scope: DiscoveryScopeBase;
}

export interface AcquisitionOutcome {
  readonly status: OutcomeStatus;
  readonly evidence: readonly Evidence[];
  readonly skipped: SkippedSummary;
  readonly limits: LimitReport;
  readonly errors: readonly DiscoveryError[];
}

export interface ConnectionValidation {
  readonly sourceId: SourceId;
  readonly validatedAt: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The smallest useful connector contract. Operations a connector does not
 * support still exist on the object but must return `UNSUPPORTED_OPERATION`
 * and be declared `'unsupported'` in the descriptor, so callers can plan
 * without calling.
 *
 * Every operation is read-only and must ask `ctx.authorization` before
 * touching the source. Source content is untrusted input: connectors must
 * never interpret it as instructions or let it widen their own scope.
 */
export interface Connector<TScope extends DiscoveryScopeBase = DiscoveryScopeBase> {
  readonly descriptor: ConnectorDescriptor;
  /**
   * Existence-level detection of the single source the request names. It
   * touches nothing but whether that named location exists and what type it
   * is: no listing, no contents. It exists so a source can appear in the
   * inventory (as "authorization required") BEFORE anything is authorized.
   */
  detectSource(request: DiscoveryRequest<TScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>>;
  validateConnection(request: DiscoveryRequest<TScope>, ctx: ConnectorContext): Promise<Result<ConnectionValidation, DiscoveryError>>;
  discover(request: DiscoveryRequest<TScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>>;
  acquireContent(
    request: AcquisitionRequest & { readonly scope: TScope },
    ctx: ConnectorContext,
  ): Promise<Result<AcquisitionOutcome, DiscoveryError>>;
}

/** Scope used when a connector asks the gate about a path; re-exported so adapters share one shape. */
export type PathScope = Extract<PermissionScope, { kind: 'path' }>;
