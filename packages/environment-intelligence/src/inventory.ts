import { err, ok, type Result } from '@xo/types';
import type { DetectedSource } from './connector.js';
import type { DiscoveryError } from './errors.js';
import type { ConnectorId, SourceId } from './ids.js';
import { INITIAL_AXES, summarize, transition, type SourceAxes, type SourceEvent, type SourceSummaryStatus } from './source-state.js';

export interface StateTransitionRecord {
  readonly at: string;
  readonly event: SourceEvent;
  readonly from: SourceSummaryStatus;
  readonly to: SourceSummaryStatus;
}

export interface SourceRecord {
  readonly source: DetectedSource;
  readonly connectorId?: ConnectorId;
  readonly axes: SourceAxes;
  /** Derived view of `axes`; see `summarize`. */
  readonly status: SourceSummaryStatus;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** How many times this source was detected (repeat detection increments this, never duplicates the record). */
  readonly observationCount: number;
  /** Number of completed content scans recorded for this source. */
  readonly scanCount: number;
  readonly lastScanFingerprint?: string;
  /** True when the latest scan's fingerprint differs from the previous scan's. False for the first scan. */
  readonly changedSinceLastScan: boolean;
  /** Set when authorization was revoked after evidence had been acquired: that evidence must be purged by its holder. */
  readonly purgeRequired: boolean;
  readonly lastError?: DiscoveryError;
  readonly history: readonly StateTransitionRecord[];
}

export interface ObserveResult {
  readonly sourceId: SourceId;
  readonly isNew: boolean;
  readonly changed: boolean;
}

const MAX_HISTORY = 50;

/**
 * The environment inventory: what has been detected and, separately, how
 * far each source has progressed. Idempotent by construction — a source
 * is identified by its deterministic `SourceId`, so scanning twice updates
 * one record instead of creating two.
 *
 * In-memory only in this milestone. Persistence, retention and purge
 * execution belong to the platform storage/retention work (P1.0/P2); the
 * `purgeRequired` flag is the hook, not the mechanism.
 */
export class EnvironmentInventory {
  private readonly records = new Map<SourceId, SourceRecord>();

  /** Records that `source` was observed. Safe to call repeatedly. */
  observe(source: DetectedSource, at: string): ObserveResult {
    const existing = this.records.get(source.sourceId);
    if (existing === undefined) {
      this.records.set(
        source.sourceId,
        Object.freeze({
          source,
          axes: INITIAL_AXES,
          status: summarize(INITIAL_AXES),
          firstSeenAt: at,
          lastSeenAt: at,
          observationCount: 1,
          scanCount: 0,
          changedSinceLastScan: false,
          purgeRequired: false,
          history: Object.freeze([]),
        }),
      );
      return { sourceId: source.sourceId, isNew: true, changed: false };
    }
    const changed = existing.source.fingerprint !== source.fingerprint;
    this.records.set(
      source.sourceId,
      Object.freeze({ ...existing, source, lastSeenAt: at, observationCount: existing.observationCount + 1 }),
    );
    return { sourceId: source.sourceId, isNew: false, changed };
  }

  /** Records the outcome of a completed content scan so repeat scans can report "unchanged" vs "changed". */
  recordScan(
    sourceId: SourceId,
    contentFingerprint: string,
    at: string,
  ): { readonly changed: boolean; readonly first: boolean } | undefined {
    const record = this.records.get(sourceId);
    if (record === undefined) return undefined;
    const first = record.lastScanFingerprint === undefined;
    const changed = !first && record.lastScanFingerprint !== contentFingerprint;
    this.records.set(
      sourceId,
      Object.freeze({
        ...record,
        lastSeenAt: at,
        scanCount: record.scanCount + 1,
        lastScanFingerprint: contentFingerprint,
        changedSinceLastScan: changed,
      }),
    );
    return { changed, first };
  }

  /** Applies a lifecycle event through the guarded state machine. An illegal transition changes nothing and is returned as an error. */
  apply(
    sourceId: SourceId,
    event: SourceEvent,
    at: string,
    options: { readonly connectorId?: ConnectorId; readonly error?: DiscoveryError } = {},
  ): Result<SourceRecord, DiscoveryError> {
    const record = this.records.get(sourceId);
    if (record === undefined) {
      return err({ code: 'EI_INVALID_TRANSITION', message: 'unknown source', retryable: false, context: { event } });
    }
    const next = transition(record.axes, event);
    if (!next.ok) return err(next.error);
    const status = summarize(next.value.axes);
    const entry: StateTransitionRecord = { at, event, from: record.status, to: status };
    const history = [...record.history, entry].slice(-MAX_HISTORY);
    const updated: SourceRecord = Object.freeze({
      ...record,
      axes: next.value.axes,
      status,
      purgeRequired: record.purgeRequired || next.value.purgeRequired,
      ...(options.connectorId !== undefined ? { connectorId: options.connectorId } : {}),
      ...(options.error !== undefined ? { lastError: options.error } : {}),
      history: Object.freeze(history),
    });
    this.records.set(sourceId, updated);
    return ok(updated);
  }

  get(sourceId: SourceId): SourceRecord | undefined {
    return this.records.get(sourceId);
  }

  /** Deterministic order (by id) so snapshots are stable across runs. */
  list(): readonly SourceRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.source.sourceId < b.source.sourceId ? -1 : a.source.sourceId > b.source.sourceId ? 1 : 0,
    );
  }

  countsByStatus(): Readonly<Partial<Record<SourceSummaryStatus, number>>> {
    const counts: Partial<Record<SourceSummaryStatus, number>> = {};
    for (const r of this.records.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
  }
}
