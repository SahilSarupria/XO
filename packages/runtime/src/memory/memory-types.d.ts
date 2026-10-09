import type { MemoryEntryId, SessionId, WorkflowInstanceId } from '../ids.js';
/**
 * Stage 5's canonical durable-memory scopes. Deliberately a *closed* set,
 * matching `@xo/permissions`' closed permission-domain pattern
 * (`domain.ts`) for the same reason: an open-ended scope string would let
 * a bug (or a malicious package) mint a scope no isolation code has ever
 * been reviewed against. Every scope kind here is one this stage's
 * architecture actually produces or needs — see the Runtime README's
 * Stage 5 section for why `capability` and `package` scopes (mentioned as
 * *candidates* in the brief) were deliberately not added: nothing in this
 * codebase currently identifies "the current capability" or "the current
 * package" as a durable, addressable scope root the way it does
 * `WorkflowInstanceId`/`SessionId`.
 *
 * - `execution` — one `WorkflowInstanceId`. The narrowest scope; never
 *   visible to any other execution, even within the same session.
 * - `session`   — one `SessionId`. Outlives a single execution and is
 *   visible to every execution created under that session (an intentional
 *   broader scope — see `RuntimeMemory.queryAcrossScopes`).
 * - `workflow`  — one `WorkflowInstanceId`, for memory a workflow itself
 *   (as opposed to one node's synthetic capability execution) intends to
 *   read/write across its own nodes. Namespaced separately from
 *   `execution` scope even though both are keyed by `WorkflowInstanceId`,
 *   because a `capability` node's *own* nested execution (Stage 3's
 *   `makeCapabilityNodeHandler` synthetic request) is a logically
 *   distinct actor from the workflow orchestrating it — see the README.
 * - `runtime`   — process-wide, not tied to any single session or
 *   execution. `scopeId` is always the literal string `"global"`.
 */
export type MemoryScopeKind = 'execution' | 'session' | 'workflow' | 'runtime';
export declare const RUNTIME_MEMORY_GLOBAL_SCOPE_ID = "global";
/**
 * A scope is a *root of isolation*, not just a label: every store
 * implementation in this stage physically partitions data by
 * `(kind, scopeId)` (a separate `Map` key prefix in-memory, a separate
 * directory on disk) specifically so cross-scope leakage is a structural
 * impossibility, not a filter a caller could forget to apply — see
 * §16/§6's isolation invariant in the Stage 5 brief.
 */
export interface MemoryScope {
    readonly kind: MemoryScopeKind;
    readonly scopeId: string;
}
export declare function executionScope(executionId: WorkflowInstanceId | string): MemoryScope;
export declare function sessionScope(sessionId: SessionId | string): MemoryScope;
export declare function workflowScope(workflowInstanceId: WorkflowInstanceId | string): MemoryScope;
export declare function runtimeScope(): MemoryScope;
export declare function scopeKey(scope: MemoryScope): string;
export declare function scopesEqual(a: MemoryScope, b: MemoryScope): boolean;
/**
 * Durable memory's lifecycle categories — deliberately small (§5 of the
 * brief: "do not invent unnecessary memory categories"). This is
 * orthogonal to *scope*: a `fact` can live at `session` or `runtime`
 * scope, a `result` is typically `execution`-scoped, etc. Not exhaustive
 * of everything a future stage might want, but every value here maps to
 * a concrete example already named in the brief (§5's "user preference,
 * workflow fact, learned context, previous result, persistent
 * configuration/context").
 */
export type MemoryEntryType = 'fact' | 'preference' | 'result' | 'context';
/** How certain the runtime is that this entry is true/useful, mirroring `@xo/compiler`'s `KnowledgeProvenance.confidence` field (0–1) — see `memory-provenance.ts` for why confidence lives on provenance here, not as a separate top-level scale (§9 of the Stage 5 brief). */
export type MemoryConfidenceValue = number;
/** Where a memory entry came from, and how sure the runtime is about it — see `memory-provenance.ts`. */
export type MemorySourceType = 'capability_output' | 'user_input' | 'system' | 'inferred';
/**
 * Runtime's own, locally-owned provenance/confidence record. Shaped
 * consistently with `@xo/compiler`'s `KnowledgeProvenance`
 * (`packages/compiler/src/knowledge/types.ts`) — structured origin
 * fields plus a single `confidence: number` — but *not* imported from
 * `@xo/xoir` or `@xo/compiler`: those fields (`documentPath`, `pages`,
 * `sectionPath`, `charOffsetRange`) describe extraction from a *source
 * document*, which has no meaning for memory a capability generated at
 * runtime. This is the runtime-specific equivalent: what execution,
 * capability, and session produced this memory, and how confident the
 * runtime is in it, per Stage 5 brief §0/§8/§9.
 */
export interface MemoryProvenance {
    readonly sourceType: MemorySourceType;
    /** The execution (`WorkflowInstanceId`) that produced this memory, if any — absent for e.g. `system`-sourced entries with no originating execution. */
    readonly executionId?: string;
    /** The capability id that produced this memory, if any. */
    readonly capabilityId?: string;
    /** The session this memory was produced under, if any. */
    readonly sessionId?: string;
    readonly recordedAt: string;
    /** 0 (no confidence) to 1 (certain). `1` for `system`/explicit `user_input` facts unless the caller states otherwise; genuinely required (not optional) so a caller can never silently omit it and have it read as "certain" — see §9's "do not silently promote uncertain information to high confidence." */
    readonly confidence: MemoryConfidenceValue;
}
export interface MemoryEntry {
    readonly id: MemoryEntryId;
    readonly scope: MemoryScope;
    readonly type: MemoryEntryType;
    /**
     * An optional semantic key ("user.preferred_language",
     * "contract_review.risk_tolerance") establishing *upsert* identity
     * within a scope: writing the same `(scope, key)` again updates the
     * same entry (deterministic id, see `memory-id.ts`) rather than
     * creating a duplicate. Absent for memory that is inherently a unique
     * event instance (e.g. one capability call's result) — see §14.
     */
    readonly key?: string;
    readonly value: unknown;
    readonly provenance?: MemoryProvenance;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** ISO timestamp. Absent means "never expires." See `memory-ttl.ts`. */
    readonly expiresAt?: string;
}
/** What a caller supplies to write an entry — `id`/`createdAt`/`updatedAt` are computed by `RuntimeMemory`/the store, never supplied by the caller (see §14's determinism requirement). */
export interface MemoryWriteInput {
    readonly scope: MemoryScope;
    readonly type: MemoryEntryType;
    readonly key?: string;
    readonly value: unknown;
    readonly provenance?: MemoryProvenance;
    readonly metadata?: Readonly<Record<string, unknown>>;
    /** Relative or absolute TTL — see `memory-ttl.ts`'s `resolveExpiresAt`. */
    readonly ttlSeconds?: number;
    readonly expiresAt?: string;
}
export interface MemoryQuery {
    readonly type?: MemoryEntryType;
    readonly key?: string;
    readonly limit?: number;
    /** Default `false` — expired entries are excluded from normal retrieval per §15. Set `true` only for inspection/debugging tooling that deliberately wants to see everything, including what's expired. */
    readonly includeExpired?: boolean;
}
//# sourceMappingURL=memory-types.d.ts.map