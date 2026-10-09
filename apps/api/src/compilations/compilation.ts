import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

/**
 * `running` exists in this union for forward-compatibility only — see
 * this milestone's completion report: every compilation this API
 * actually produces today runs synchronously inside the request that
 * created it, so a persisted record's status is always `'succeeded'` or
 * `'failed'` by the time `POST .../compile` returns; nothing ever
 * observes a `'running'` record via `GET`. A future asynchronous job
 * implementation would be the first caller to actually persist that
 * status — this type is not claiming that capability exists yet.
 */
export type CompilationStatus = 'running' | 'succeeded' | 'failed';

export interface CompilationRecord {
  readonly compilationId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly sourceId: string;
  /** The `SourceRecord.digestSha256` of the exact bytes this compilation ran against — the provenance link a caller uses to tell "was this source re-uploaded since this compilation ran" apart from "is this the same content". */
  readonly sourceDigestSha256: string;
  readonly status: CompilationStatus;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** Present only when `status === 'succeeded'`. */
  readonly resultStorageKey?: string;
  /** Present only when `status === 'failed'` — always an existing `@xo/errors` `ErrorCode`, never an invented one (see the completion report's "error/status behavior"). */
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * The API-safe capability projection this milestone returns from `GET
 * .../capabilities` — assembled from two existing, unmodified compiler
 * outputs (see `compile-source.ts`'s doc comment for exactly where each
 * field comes from): the raw discovered `capability` XOIR nodes, and
 * `packageXoirGraph`'s `LowerCapabilitiesResult` (the same preview-only
 * lowering `xo capabilities` already performs). Not a redesign of the
 * compiler's own taxonomy — every field here is copied from an existing
 * type, never invented.
 */
export interface CapabilityProjection {
  /** The discovered XOIR `capability` node's id. */
  readonly capabilityId: string;
  /** `LoweredCapabilityOutcome.contractId` — typically, but not necessarily, equal to `capabilityId` (see `@xo/types`' `CapabilityExecutionDeclaration.contractId` doc comment). */
  readonly contractId: string;
  readonly name: string;
  readonly description: string;
  /** `LoweredCapabilityOutcome.status` — `'resolved' | 'unresolved' | 'ambiguous' | 'denied'`, unchanged from `@xo/capability-contract`'s own `BindingOutcome`. */
  readonly status: 'resolved' | 'unresolved' | 'ambiguous' | 'denied';
  /** `declaration.execution.mode` — present only for a `'resolved'` outcome whose binding was actually lowerable into a manifest declaration (see `LoweredCapabilityOutcome.declaration`'s own doc comment for when that's not the same thing as `status === 'resolved'`). */
  readonly executionClass?: string;
  /** Present only when `status !== 'resolved'` (or resolved-but-not-lowered) — `LoweredCapabilityOutcome.reason`, unchanged. */
  readonly reason?: string;
  /** The discovered node's own `metadata.confidence` — always present for every discovered capability, independent of resolution status. */
  readonly confidence: number;
  /** `declaration.confidence` — present only when a manifest-level declaration exists (a strictly narrower condition than `status === 'resolved'`). */
  readonly declaredConfidence?: { readonly score: number; readonly basis: string };
  readonly provenance: readonly { readonly documentPath: string; readonly locator?: string; readonly pages?: readonly number[] }[];
}

export interface CreateCompilationInput {
  readonly sourceId: string;
  readonly sourceDigestSha256: string;
}

export interface CompilationSuccessInput {
  readonly capabilities: readonly CapabilityProjection[];
  readonly discoveredCount: number;
  readonly resolvedCount: number;
  /**
   * The compiled `XoirGraph`, serialized via `@xo/xoir`'s own
   * `toJson`/`fromJson` (P0.5 addition — additive to P0.4's stored
   * result shape, never removed/renamed anything P0.4 wrote). Needed so
   * `executions/execute-capability.ts` can rebuild the exact same graph
   * this compilation ran against — re-deriving `SemanticCapabilityContract`/
   * `CapabilityBinding` at execution time from the reviewed/approved
   * compilation's own graph, never from a fresh recompile that could
   * have silently drifted from what was actually approved. Not exposed
   * on `CapabilityProjection` or any wire response — internal to
   * `result.json` only.
   */
  readonly graph: unknown;
}

export interface CompilationFailureInput {
  readonly errorCode: string;
  readonly errorMessage: string;
}

/**
 * Same "scoped to exactly one already-ownership-checked workspace by
 * construction" design as P0.3's `SourceStore` — a `CompilationStore`
 * instance is always built from `workspaceCompilationsStore` (see
 * `workspace/workspace-context.ts`), so there is no cross-workspace
 * query this interface could answer even by mistake.
 */
export interface CompilationStore {
  /** Creates a record and immediately marks it running (`startedAt` set) — the caller (`compile-source.ts`) is responsible for calling `markSucceeded`/`markFailed` before the HTTP response is ever sent, since this milestone is synchronous-only. */
  create(workspaceId: string, identityId: string, input: CreateCompilationInput): Promise<Result<CompilationRecord, XoError>>;
  markSucceeded(compilationId: string, input: CompilationSuccessInput): Promise<Result<CompilationRecord, XoError>>;
  markFailed(compilationId: string, input: CompilationFailureInput): Promise<Result<CompilationRecord, XoError>>;
  get(compilationId: string): Promise<Result<CompilationRecord, NotFoundError>>;
  list(): Promise<Result<readonly CompilationRecord[], XoError>>;
  getCapabilities(compilationId: string): Promise<Result<readonly CapabilityProjection[], NotFoundError>>;
  /** The serialized graph a succeeded compilation ran against — see `CompilationSuccessInput.graph`'s doc comment. `unknown` here too; the caller (`executions/execute-capability.ts`) is responsible for validating it as a real `XoirGraphJson` via `@xo/xoir`'s own `fromJson`. */
  getCompiledGraph(compilationId: string): Promise<Result<unknown, NotFoundError>>;
}

const COMPILATION_ID_PATTERN = /^cmp_[0-9a-f]{32}$/;

export function isValidCompilationId(value: string): boolean {
  return COMPILATION_ID_PATTERN.test(value);
}
