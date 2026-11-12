import type { AuthenticatedPrincipal } from '@xo/permissions';
import {
  DEFAULT_FILESYSTEM_LIMITS,
  SourceId,
  acquireSourceContent,
  acquireSourceContent as acquireContentForRehydrate,
  createKnowledgeSdk,
  deriveKnowledge,
  ingestSource,
  type Deriver,
  type EvidencePurgeTarget,
  type EvidenceStaging,
  type KnowledgeModel,
  type KnowledgePlatform,
  purgeSourceEvidence,
  removeResourceEvidence,
  revokeSourceEvidence,
  type EvidenceLedger,
  discoverSource,
  queryCapabilities,
  toSdkError,
  type ConnectorContext,
  type DiscoveryDeps,
  type DiscoveryError,
  type FilesystemScope,
} from '@xo/environment-intelligence';
import { failResult, okResult, type ConnectResult, type FolderEntry } from './contract.js';
import type { KnowledgePort } from './knowledge.js';
import type { DecisionStore } from './decisions.js';
import type { CapabilityProbe, IngestOutcome, Listing, LocalFolderBackend, ReadOutcome, ReadRequest, SourceFacts } from './ports.js';

export interface EiLocalFolderBackendOptions {
  /** Registry (with the local filesystem connector) and inventory. Supplied by the host's composition root. */
  readonly deps: DiscoveryDeps;
  /**
   * Builds the connector context for one caller: clock, the platform authorization port, the audit recorder, ledger and state.
   * Connect never constructs these itself, so it cannot weaken them.
   */
  readonly contextFor: (principal: AuthenticatedPrincipal) => ConnectorContext;
  /** Cloud sources only (C7.5): why a source's access ended, from the connection manager (`manager.list`). Local folders have none. */
  /**
   * Present only when the host runs a durable state store and evidence ledger (the context from `contextFor` then carries both). Enables
   * retained evidence: `ingest`, `evidenceCount` and `removeEvidence`. Without it Connect reads and counts but retains nothing.
   */
  readonly ledger?: EvidenceLedger;
  /**
   * Knowledge derivation (needs `ledger`). `model` and `staging` are the process-local stores C5/C6 read; the adapter derives into them after
   * each retained read and re-hydrates them from the durable index after a restart.
   */
  readonly knowledge?: { readonly model: KnowledgeModel; readonly staging: EvidenceStaging; readonly deriver?: Deriver };
  readonly endedReasonFor?: (sourceId: string) => 'expired' | 'revoked' | undefined;
}

const fail = <T>(e: DiscoveryError): ConnectResult<T> => {
  const s = toSdkError(e);
  return failResult(s.code, s.message, s.retryable);
};

const scopeOf = (root: string, excludedNames: readonly string[], structuredRecords = false): FilesystemScope => ({
  kind: 'filesystem_root',
  root,
  ...(structuredRecords ? { structuredRecords: true } : {}),
  ...(excludedNames.length > 0 ? { extraExcludedNames: excludedNames } : {}),
});

/**
 * Adapts the Environment Intelligence local-filesystem path to the C7 `LocalFolderBackend` port.
 * Reuses `discoverSource` and `acquireSourceContent` unchanged; every call is authorized and audited by EI. Adds no authorization of its own.
 */
export function createEiLocalFolderBackend(options: EiLocalFolderBackendOptions): LocalFolderBackend {
  const { deps, contextFor } = options;
  // Sources whose knowledge has been derived in THIS process. Memory-only, like the model it describes.
  const derivedSources = new Set<string>();
  return {
    maxItemsPerRead: DEFAULT_FILESYSTEM_LIMITS.maxContentFiles,

    async list(principal, request): Promise<ConnectResult<Listing>> {
      const run = await discoverSource(
        deps,
        { sourceType: 'local_filesystem', scope: scopeOf(request.root, request.excludedNames) },
        contextFor(principal),
      );
      if (!run.ok) return fail(run.error);
      if (run.value.stoppedBecause !== undefined) return fail(run.value.stoppedBecause);
      if (run.value.record.axes.authorization !== 'granted')
        return failResult('denied', 'the principal is not authorized for this operation');
      const entries: FolderEntry[] = [];
      let totalBytes = 0;
      for (const e of run.value.evidence) {
        if (e.kind !== 'resource_inventory') continue;
        const p = e.payload as Record<string, unknown>;
        const size = typeof p['sizeBytes'] === 'number' ? p['sizeBytes'] : 0;
        totalBytes += size;
        entries.push({
          key: e.resourceKey,
          name: String(p['name'] ?? ''),
          extension: String(p['extension'] ?? ''),
          sizeBytes: size,
          modifiedAt: String(p['modifiedAt'] ?? ''),
          depth: typeof p['depth'] === 'number' ? p['depth'] : 0,
          contentAcquirable: p['contentAcquirable'] === true,
        });
      }
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const out = run.value.outcome;
      const limitsHit = out?.limits.hit ?? [];
      return okResult({
        sourceId: run.value.record.source.sourceId,
        entries,
        truncated: limitsHit.length > 0 || out?.status === 'partial',
        totalBytes,
        skippedByReason: out?.skipped.byReason ?? {},
        limitsHit,
      });
    },

    async read(principal, request): Promise<ConnectResult<ReadOutcome>> {
      const r = await acquireSourceContent(
        deps,
        {
          sourceId: SourceId(request.sourceId),
          kind: 'document_content',
          resourceKeys: request.keys,
          scope: scopeOf(request.root, request.excludedNames),
        },
        contextFor(principal),
      );
      if (!r.ok) return fail(r.error);
      const read = new Set(r.value.evidence.filter((e) => e.kind === 'document_content').map((e) => e.resourceKey));
      return okResult({
        itemsRead: read.size,
        partial: r.value.status === 'partial',
        errorCodes: [...new Set(r.value.errors.map((e) => e.code))],
      });
    },

    ...(options.ledger === undefined
      ? {}
      : {
          async ingest(principal: AuthenticatedPrincipal, request: ReadRequest): Promise<ConnectResult<IngestOutcome>> {
            const r = await ingestSource(
              deps,
              {
                sourceId: SourceId(request.sourceId),
                kind: 'document_content',
                scope: {
                  ...scopeOf(request.root, request.excludedNames, options.knowledge !== undefined),
                  includeKeys: request.keys,
                  ...((request.epoch ?? 0) > 0 ? { epoch: request.epoch } : {}),
                },
              },
              contextFor(principal),
            );
            if (!r.ok) return fail(r.error);
            const stopped = r.value.stoppedBecause;
            const errorCodes: string[] = stopped !== undefined ? [toSdkError(stopped).code] : [];
            let partial = r.value.status === 'partial' || r.value.status === 'stopped' || stopped !== undefined;
            let assertionsAdded: number | undefined;
            let notUnderstood: number | undefined;
            const kn = options.knowledge;
            if (kn !== undefined && !partial) {
              const sid = SourceId(request.sourceId);
              let derived;
              if (!derivedSources.has(sid)) {
                // First read in this process (model and staged payloads are memory-only): re-read the present chosen items so their
                // payloads are staged, then derive from everything the durable index holds for the source.
                const present = request.presentKeys ?? [];
                if (present.length > 0) {
                  const acq = await acquireContentForRehydrate(
                    deps,
                    {
                      sourceId: sid,
                      kind: 'document_content',
                      resourceKeys: present,
                      scope: { ...scopeOf(request.root, request.excludedNames, options.knowledge !== undefined) },
                    },
                    contextFor(principal),
                  );
                  if (!acq.ok) return fail(acq.error);
                }
                const ids = (options.ledger as EvidenceLedger).idsOf(sid, ['released']).filter((id) => kn.staging.read([id]).length > 0);
                derived = await deriveKnowledge(
                  kn.model,
                  deps,
                  { sourceId: sid, reader: kn.staging, evidenceIds: ids, ...(kn.deriver !== undefined ? { deriver: kn.deriver } : {}) },
                  contextFor(principal),
                );
              } else if (r.value.items.length > 0) {
                derived = await deriveKnowledge(
                  kn.model,
                  deps,
                  { sourceId: sid, reader: kn.staging, ingestion: r.value, ...(kn.deriver !== undefined ? { deriver: kn.deriver } : {}) },
                  contextFor(principal),
                );
              }
              if (derived !== undefined) {
                if (derived.ok) {
                  derivedSources.add(sid);
                  assertionsAdded = derived.value.assertionsAdded;
                  notUnderstood = Object.values(derived.value.refused).reduce((a, b) => a + b, 0);
                } else {
                  errorCodes.push(`knowledge_${toSdkError(derived.error).code}`);
                  partial = true;
                }
              }
            }
            return okResult({
              itemsIngested: r.value.items.length,
              itemsRetired: r.value.retired.length,
              ...(assertionsAdded !== undefined ? { assertionsAdded } : {}),
              ...(notUnderstood !== undefined ? { notUnderstood } : {}),
              partial,
              errorCodes,
            });
          },
          async removeEvidenceItems(
            principal: AuthenticatedPrincipal,
            request: { readonly sourceId: string; readonly keys: readonly string[] },
          ): Promise<ConnectResult<{ readonly itemsRetired: number }>> {
            const kn = options.knowledge;
            const holders: EvidencePurgeTarget[] = kn === undefined ? [] : [kn.model, { purge: async (ids) => kn.staging.drop(ids) }];
            const r = await removeResourceEvidence(
              { inventory: deps.inventory },
              { sourceId: SourceId(request.sourceId), kind: 'document_content', resourceKeys: request.keys, targets: holders },
              contextFor(principal),
            );
            if (!r.ok) return fail(r.error);
            kn?.model.sweep(options.ledger as EvidenceLedger);
            return okResult({ itemsRetired: r.value.evidenceIds.length });
          },
          evidenceCount(sourceId: string): number {
            return (options.ledger as EvidenceLedger).idsOf(SourceId(sourceId), ['released']).length;
          },
          async removeEvidence(
            principal: AuthenticatedPrincipal,
            sourceId: string,
          ): Promise<ConnectResult<{ readonly itemsRetired: number }>> {
            const ctx = contextFor(principal);
            const lifecycle = { inventory: deps.inventory, ledger: options.ledger as EvidenceLedger };
            const before = lifecycle.ledger.idsOf(SourceId(sourceId), ['released']).length;
            const held = lifecycle.ledger.idsOf(SourceId(sourceId), ['released']);
            // Revoke first (evidence is ineligible immediately). Then purge: every holder of the evidence deletes its copy BEFORE the ledger
            // marks it purged, so a failing holder leaves it revoked, never purged-but-still-held. The knowledge model and the staged
            // payloads are holders.
            const revoked = await revokeSourceEvidence(lifecycle, { sourceId: SourceId(sourceId) }, ctx);
            if (!revoked.ok) return fail(revoked.error);
            const kn = options.knowledge;
            const holders: EvidencePurgeTarget[] = kn === undefined ? [] : [kn.model, { purge: async (ids) => kn.staging.drop(ids) }];
            const purged = await purgeSourceEvidence(lifecycle, { sourceId: SourceId(sourceId), targets: holders }, ctx);
            if (!purged.ok) return fail(purged.error);
            // Belt and braces: nothing derived outlives the evidence it rests on.
            kn?.model.sweep(lifecycle.ledger);
            kn?.staging.drop(held);
            derivedSources.delete(SourceId(sourceId));
            return okResult({ itemsRetired: before });
          },
        }),
    facts(sourceId): SourceFacts | undefined {
      const rec = deps.inventory.get(SourceId(sourceId));
      if (rec === undefined) return undefined;
      return {
        authorization: rec.axes.authorization,
        connection: rec.axes.connection,
        acquisition: rec.axes.acquisition,
        unavailable: rec.axes.unavailable,
        ...(rec.lastError !== undefined ? { lastErrorCode: rec.lastError.code } : {}),
        ...(options.endedReasonFor?.(sourceId) !== undefined
          ? { endedReason: options.endedReasonFor(sourceId) as 'expired' | 'revoked' }
          : {}),
      };
    },
  };
}

/**
 * Capability query through Environment Intelligence's audited `queryCapabilities`: one platform-gate decision per capability, each
 * audited write-ahead. If the gate or the audit cannot answer, nothing is allowed and the error is reported (never a guessed answer).
 * The result is advisory; every action is decided again when it runs.
 */
export function createEiCapabilityProbe(contextFor: (principal: AuthenticatedPrincipal) => ConnectorContext): CapabilityProbe {
  return {
    async probe(principal) {
      const r = await queryCapabilities(contextFor(principal));
      if (!r.ok) return fail(r.error);
      return okResult({ ...r.value, advisory: true });
    },
  };
}

const fromSdk = <T>(
  r:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } },
): ConnectResult<T> =>
  r.ok
    ? okResult(r.value)
    : failResult(
        (['unauthenticated', 'denied', 'unavailable', 'limit_exceeded', 'invalid_request'] as const).find((c) => c === r.error.code) ??
          'internal',
        r.error.message,
        r.error.retryable,
      );

/**
 * Read-only knowledge access through the C6 SDK, unchanged. `platform` is built once the durable state is operational (the SDK holds no
 * per-principal state; the principal is supplied on every call).
 */
export function createEiKnowledgePort(options: {
  readonly model: KnowledgeModel;
  readonly platform: () => KnowledgePlatform;
  /** Where decisions are made durable. Without it decisions live in memory only. */
  readonly decisions?: DecisionStore;
}): KnowledgePort {
  let sdk: ReturnType<typeof createKnowledgeSdk> | undefined;
  const get = (): ReturnType<typeof createKnowledgeSdk> =>
    (sdk ??= createKnowledgeSdk({ model: options.model, platform: options.platform() }));
  return {
    async search(principal, request) {
      return fromSdk(
        await get().query({
          principal,
          query: request.query,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
          ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
        }),
      );
    },
    async reviewQueue(principal, asOf) {
      return fromSdk(await get().reviewQueue({ principal, ...(asOf !== undefined ? { asOf } : {}) }));
    },
    async submitReview(principal, decision) {
      const before = options.model.decisions();
      const r = fromSdk(await get().submitReview({ principal, decision }));
      if (!r.ok || options.decisions === undefined) return r;
      try {
        await options.decisions.save(options.model.decisions());
        return r;
      } catch {
        // Not durable means not applied: put the model back exactly as it was, so memory never runs ahead of the saved decisions.
        const keep = new Set(before.map((d) => d.id));
        for (const d of options.model.decisions()) if (!keep.has(d.id)) options.model.removeDecision(d.id);
        for (const d of before) options.model.addDecision(d);
        return failResult('unavailable', 'the decision could not be saved, so it was not applied', true);
      }
    },
    decisionHistory: () =>
      options.model.decisions().map((d) => ({ id: d.id, kind: d.kind, principalId: d.principalId, decidedAt: d.decidedAt })),
    assertionCount: () => options.model.size,
  };
}
