import type { AuthenticatedPrincipal } from '@xo/permissions';
import type { Capabilities, ConnectResult, FolderEntry, HistoryEvent } from './contract.js';

/**
 * The narrow facts Connect needs about a source's platform state. Mirrors the Environment Intelligence source axes without
 * importing them, so the state mapping is testable without a backend.
 */
export interface SourceFacts {
  readonly authorization: 'not_requested' | 'required' | 'granted' | 'denied' | 'revoked';
  readonly connection: 'not_planned' | 'required' | 'configured' | 'validated' | 'failed';
  readonly acquisition: 'not_attempted' | 'succeeded' | 'partial' | 'failed';
  readonly unavailable: boolean;
  readonly lastErrorCode?: string;
  /** Cloud sources only: why access ended, when the connection manager knows. Local folders never have one. */
  readonly endedReason?: 'expired' | 'revoked';
}

export interface Listing {
  readonly sourceId: string;
  readonly entries: readonly FolderEntry[];
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly skippedByReason: Readonly<Record<string, number>>;
  readonly limitsHit: readonly string[];
}

export interface ReadOutcome {
  /** Distinct items whose content was read. */
  readonly itemsRead: number;
  readonly partial: boolean;
  readonly errorCodes: readonly string[];
}

export interface IngestOutcome {
  readonly itemsIngested: number;
  readonly itemsRetired: number;
  /** Assertions added to the knowledge model by this read, when the host derives knowledge. */
  readonly assertionsAdded?: number;
  /** Retained items the deriver could not turn into knowledge (unsupported or malformed content). Counts only. */
  readonly notUnderstood?: number;
  readonly partial: boolean;
  readonly errorCodes: readonly string[];
}

export interface ListRequest {
  readonly root: string;
  readonly excludedNames: readonly string[];
}

export interface ReadRequest extends ListRequest {
  readonly sourceId: string;
  /** Already validated, selected, present and acquirable. The backend must still enforce its own scope. */
  readonly keys: readonly string[];
  /** The subset of `keys` that currently exists and is readable as text. Used to re-read content when knowledge is re-derived. */
  readonly presentKeys?: readonly string[];
  readonly epoch?: number;
}

/**
 * Everything C7 needs from the backend for the local-folder journey. Implemented over Environment Intelligence by
 * `createEiLocalFolderBackend`; tests may supply fakes. Every method runs as the given authenticated principal and must go through
 * the platform authorization gate: Connect never decides authorization itself.
 */
export interface LocalFolderBackend {
  /** The most items the backend reads in one `read` call. Connect chunks to this. */
  readonly maxItemsPerRead: number;
  list(principal: AuthenticatedPrincipal, request: ListRequest): Promise<ConnectResult<Listing>>;
  read(principal: AuthenticatedPrincipal, request: ReadRequest): Promise<ConnectResult<ReadOutcome>>;
  facts(sourceId: string): SourceFacts | undefined;
  /**
   * OPTIONAL durable path. Present only when the host has a durable state store. Reads and RETAINS the chosen items as eligible
   * evidence and retires evidence of chosen items that were deleted or changed. `keys` is every chosen, non-excluded item, including
   * ones that may have vanished: the backend learns of a deletion only by being told the item is still in scope.
   */
  ingest?(principal: AuthenticatedPrincipal, request: ReadRequest): Promise<ConnectResult<IngestOutcome>>;
  /** OPTIONAL. How much retained evidence the source holds. */
  evidenceCount?(sourceId: string): number;
  /**
   * OPTIONAL. Retires the retained evidence of specific items (and removes what was derived from it) through the platform gate. The caller
   * must also stop reading the items, or the next read learns them again.
   */
  removeEvidenceItems?(
    principal: AuthenticatedPrincipal,
    request: { readonly sourceId: string; readonly keys: readonly string[] },
  ): Promise<ConnectResult<{ readonly itemsRetired: number }>>;
  /** OPTIONAL. Revokes then purges all retained evidence of the source (fail-safe order), through the platform gate. */
  removeEvidence?(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<{ readonly itemsRetired: number }>>;
}

/** Asks the platform authorization gate what a principal may do. Fail closed: an error is `unavailable`, never "allowed". */
export interface CapabilityProbe {
  probe(principal: AuthenticatedPrincipal): Promise<ConnectResult<Capabilities>>;
}

// -- Connect's own state -----------------------------------------------------------------------------------------------

/**
 * Per-owner configuration of one connected folder. Connect keeps the approved folder path and the chosen item keys locally, because
 * it must re-list and re-read; it never returns the path through its contract.
 */
export interface SourceConfig {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly root: string;
  readonly includeKeys: readonly string[];
  readonly excludedNames: readonly string[];
  readonly disconnected: boolean;
  readonly createdAt: string;
  readonly lastReadAt?: string;
  /** Bumped whenever retained evidence is retired, so the next read is a full read rather than "unchanged". */
  readonly epoch?: number;
  readonly history: readonly HistoryEvent[];
}

export interface ConnectState {
  readonly version: 1;
  /** Keyed by `${ownerId}/${sourceId}`. A principal can only ever address its own entries. */
  readonly sources: Readonly<Record<string, SourceConfig>>;
}

export interface ConnectStateStore {
  load(): Promise<ConnectState>;
  /** Replaces the whole state atomically. Throws if persistence cannot be completed; callers treat that as `unavailable`. */
  save(state: ConnectState): Promise<void>;
}

export const EMPTY_STATE: ConnectState = Object.freeze({ version: 1, sources: Object.freeze({}) });
export const configKey = (ownerId: string, sourceId: string): string => `${ownerId}/${sourceId}`;
