/**
 * XO Connect application contract (C7), version 1.
 *
 * Pure data shapes. No Studio, React, HTTP or Environment Intelligence types appear here, so any interface (Studio, CLI, API)
 * can render them. Everything returned is derived from real backend state; `dataProvenance` is always `'live'`. Sample data
 * is a presentation concern and is never produced by this package.
 */
export const CONNECT_CONTRACT_VERSION = '1' as const;

// -- errors ------------------------------------------------------------------------------------------------------------

export type ConnectErrorCode =
  'unauthenticated' | 'denied' | 'unavailable' | 'limit_exceeded' | 'invalid_request' | 'not_found' | 'conflict' | 'internal';

/** Content-free: never carries a path, file name or file content. */
export interface ConnectError {
  readonly code: ConnectErrorCode;
  readonly message: string;
  /** True only when retrying later can succeed. */
  readonly retryable: boolean;
}

export type ConnectResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ConnectError };

export const okResult = <T>(value: T): ConnectResult<T> => ({ ok: true, value });
export const failResult = <T = never>(code: ConnectErrorCode, message: string, retryable = false): ConnectResult<T> => ({
  ok: false,
  error: { code, message, retryable },
});

// -- sources -----------------------------------------------------------------------------------------------------------

export type SourceKind = 'local_folder';

/**
 * Connection state as the user should understand it. Derived (never stored) from the platform's source axes plus Connect's own
 * stop flag. `access_ended` deliberately does NOT say whether access was revoked or expired: the inventory records both the same
 * way today (see HTTP_CONTRACT.md, frozen-code dependency D-2).
 */
export type SourceState =
  | 'awaiting_first_read'
  | 'read_complete'
  | 'read_partial'
  | 'needs_attention'
  | 'access_ended'
  | 'access_expired'
  | 'disconnected'
  | 'setup_incomplete'
  | 'unsupported';

export interface Attention {
  /** Stable machine code, e.g. `read_failed`, `access_ended`, `platform_record_missing`. */
  readonly code: string;
  readonly message: string;
}

export interface SourceCard {
  readonly id: string;
  readonly kind: SourceKind;
  /** The last path segment of the approved folder. The full path is never returned. */
  readonly displayName: string;
  readonly state: SourceState;
  /** Connect never writes to, moves or deletes anything in a source. */
  readonly readOnly: true;
  readonly lastReadAt?: string;
  readonly selection: { readonly includedItems: number; readonly excludedNames: number };
  readonly attention?: Attention;
  readonly dataProvenance: 'live';
}

export type HistoryKind = 'connected' | 'read' | 'selection_changed' | 'disconnected' | 'reconnected';

/** Result of one read. Counts only; no names, paths or content. */
export interface ReadReport {
  readonly requested: number;
  readonly read: number;
  readonly unreadable: number;
  readonly skipped: { readonly notIncluded: number; readonly notAcquirable: number; readonly vanished: number };
  readonly status: 'complete' | 'partial' | 'failed';
  readonly errorCodes: readonly string[];
  /**
   * `retained`: what was read is now held as eligible evidence (real ingestion through the durable state store). `not_retained`: the
   * host has no durable store, so content was read and counted but not kept. Knowledge itself is derived from retained evidence at
   * query time (C7.3); this field never claims it exists.
   */
  readonly evidence: 'retained' | 'not_retained';
  /** Items whose retained evidence was retired by this read because the item was deleted or changed. */
  readonly retired: number;
  /** Knowledge items newly derived from what was read, when the host derives knowledge. Absent when it does not. */
  readonly assertionsAdded?: number;
  /**
   * Retained items that could not be turned into knowledge. The shipped deriver understands only structured organizational records
   * (`ei.org-record.v1`); free text is kept and counted but not understood. Never hide this from the user.
   */
  readonly notUnderstood?: number;
}

export interface HistoryEvent {
  readonly at: string;
  readonly kind: HistoryKind;
  readonly read?: ReadReport;
  readonly includedItems?: number;
}

export interface SourceDetail extends SourceCard {
  /** Newest last, bounded. */
  readonly history: readonly HistoryEvent[];
}

/** What an action did and did not do, so wording can be true. */
export interface ActionEffects {
  readonly futureReads: 'stopped' | 'narrowed' | 'widened' | 'resumed' | 'unchanged';
  /** Connect actions never remove or change what XO already learned (removal is separate, gated work). */
  readonly existingKnowledge: 'kept';
  /** Connect actions never change the platform authorization grant. */
  readonly platformAuthorization: 'unchanged';
}

export interface ActionResult {
  readonly source: SourceDetail;
  readonly effects: ActionEffects;
}

// -- capabilities ------------------------------------------------------------------------------------------------------

/**
 * What the caller may do, as asked of the SAME platform authorization gate that enforces the actions. Capability-based only: there are
 * no roles. ADVISORY: it tells a UI which actions to offer; every action is still decided again when it runs. Per-folder reading
 * (`filesystem.list`/`read` on a specific root) cannot be probed without a root, so it is decided when a folder is previewed.
 */
export interface Capabilities {
  readonly viewSources: boolean;
  readonly manageSources: boolean;
  readonly readKnowledge: boolean;
  readonly reviewKnowledge: boolean;
  readonly advisory: true;
}

// -- catalog and dashboard ---------------------------------------------------------------------------------------------

export type AddSourceKind = 'local_folder' | 'microsoft_365' | 'google_workspace';

export interface AddSourceEntry {
  readonly kind: AddSourceKind;
  readonly availability: 'available' | 'coming_soon';
  /** Honest note for the user. Cloud entries are never presented as data sources. */
  readonly note: string;
}

export interface DashboardSummary {
  readonly connectedSources: number;
  readonly needsAttention: number;
  /** C7.3 populates this from C6. Until then it says so rather than showing zeros. */
  readonly knowledge: { readonly availability: 'not_available' | 'empty' | 'ready'; readonly reason: string };
  readonly dataProvenance: 'live';
}

// -- local folder journey ----------------------------------------------------------------------------------------------

export interface FolderEntry {
  /** Path relative to the approved folder. */
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly depth: number;
  readonly contentAcquirable: boolean;
}

export interface PreviewFolderRequest {
  readonly root: string;
  readonly excludedNames?: readonly string[];
}

export interface FolderPreview {
  readonly entries: readonly FolderEntry[];
  readonly truncated: boolean;
  readonly summary: {
    readonly files: number;
    readonly acquirableFiles: number;
    readonly totalBytes: number;
    readonly skippedByReason: Readonly<Record<string, number>>;
    readonly limitsHit: readonly string[];
  };
  /** The preview lists names and metadata only. No file content is read. */
  readonly listingOnly: true;
}

/** A connected folder's current listing together with what is chosen now, so the selection can be changed. Names and metadata only. */
export interface SourceFolderView {
  readonly preview: FolderPreview;
  /** Resource keys chosen now. Some may no longer be in `preview.entries` (deleted since). */
  readonly selectedKeys: readonly string[];
  readonly excludedNames: readonly string[];
}

export interface ConnectFolderRequest {
  readonly root: string;
  /** Resource keys the user chose. Must be non-empty: nothing is ever preselected. */
  readonly includeKeys: readonly string[];
  readonly excludedNames?: readonly string[];
}

export interface UpdateSelectionRequest {
  readonly includeKeys: readonly string[];
  readonly excludedNames?: readonly string[];
}

// -- removal -----------------------------------------------------------------------------------------------------------

export interface RemovalPreview {
  /** Pieces of retained evidence that removing this source would retire and purge. */
  readonly evidenceItems: number;
  /**
   * Per-fact dependency counts ("N items depend only on this source; M also have other sources") come from C6 provenance and are not
   * available yet (C7.3/C7.4). Until then no claim about other sources may be made.
   */
  readonly factDependencies: 'not_available';
}

export interface RemovalResult {
  readonly removed: true;
  readonly evidenceItemsRetired: number;
  /** The source and its retained evidence are gone; files in the folder are untouched. */
  readonly sourceFilesChanged: false;
}

// -- bounds ------------------------------------------------------------------------------------------------------------

export const MAX_INCLUDE_KEYS = 5000;
export const MAX_KEY_LENGTH = 1024;
export const MAX_EXCLUDED_NAMES = 100;
export const MAX_NAME_LENGTH = 200;
export const MAX_ROOT_LENGTH = 4096;
export const MAX_HISTORY = 50;
