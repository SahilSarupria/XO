import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import { MemoryEntryId } from '../ids.js';
import type { MemoryRecordStore, VersionedEnvelope } from '../persistence/runtime-store.interface.js';
import { type MemoryPermissionGate, type MemoryPermissionRequester } from './memory-permission-gate.interface.js';
import type { MemoryEntry, MemoryQuery, MemoryScope, MemoryWriteInput } from './memory-types.js';
export interface RuntimeMemoryOptions {
    /** Defaults to `allowAllMemoryPermissionGate` — memory access is unrestricted unless a host explicitly wires in a real gate (typically `createPermissionManagerMemoryGate`), matching every other permission port in this package (§7). */
    readonly permissionGate?: MemoryPermissionGate;
    readonly now?: () => Date;
}
/**
 * The canonical, scope-isolating, permission-checked runtime memory API —
 * "what information does the runtime remember across executions, how is
 * it scoped, how is it retrieved, and how is it persisted safely" (Stage
 * 5 §1). Sits directly on top of a `MemoryRecordStore` (typically
 * `runtimeStore.memory` — Stage 4's `InMemoryRuntimeStore`/`FileRuntimeStore`,
 * see `persistence/runtime-store.interface.ts`), adding exactly three
 * things the raw store deliberately doesn't do itself: permission checks
 * (§7), deterministic-vs-random id assignment and upsert semantics (§4,
 * §14), and `queryAcrossScopes` — the one, explicit, intentional way to
 * read memory belonging to a *broader* scope than the caller's own
 * (§6's "Session memory -> new execution in same session -> allowed").
 *
 * With no `store` supplied, defaults to a fresh, process-local
 * `InMemoryDurableMemoryStore` — useful for tests and for a caller that
 * wants `RuntimeMemory`'s API without committing to durability; a host
 * that wants memory to survive a restart must construct this with
 * `runtimeStore.memory` from a `FileRuntimeStore`.
 */
export declare class RuntimeMemory {
    private readonly store;
    private readonly permissionGate;
    private readonly now;
    constructor(store?: MemoryRecordStore, options?: RuntimeMemoryOptions);
    /**
     * Writes (or, for a keyed entry, upserts) one memory entry.
     *
     * - `input.key` given: id is derived deterministically from
     *   `(input.scope, input.key)` (§4/§14) — writing the same key again
     *   replaces the existing entry's `value`/`provenance`/`metadata`/TTL
     *   while preserving its original `createdAt` (an upsert, not a fresh
     *   record with a coincidentally-equal id).
     * - `input.key` absent: id is a fresh random id every call — each
     *   write is its own event instance (§14), never collapsed with a
     *   prior one.
     */
    put(input: MemoryWriteInput, requester?: MemoryPermissionRequester): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>>;
    get(scope: MemoryScope, id: MemoryEntryId, requester?: MemoryPermissionRequester): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>>;
    /** Reads memory matching `query` within exactly one scope — never leaks into any other scope, even a related/broader one. Use {@link queryAcrossScopes} for the deliberate broader-scope case. */
    query(scope: MemoryScope, query?: MemoryQuery, requester?: MemoryPermissionRequester): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
    /**
     * The explicit, intentional mechanism for reading memory across more
     * than one scope in a single call (§6: "Session memory -> new
     * execution in same session -> allowed [...] where the declared scope
     * permits it"). Every scope in `scopes` is checked independently
     * against `permissionGate` with the `'share'` action (in addition to
     * `'read'`) whenever more than one scope is requested — a caller
     * asking to read across scopes is doing something a plain `query`
     * can't, and that's exactly what `'share'` exists to gate (§7). A scope
     * denied `'share'`/`'read'` is simply omitted from the merged result
     * rather than failing the whole call — one execution's memory being
     * inaccessible shouldn't block a caller from still getting the session
     * memory it *is* allowed to see. Results are merged and sorted by
     * `createdAt` (ties broken by id) exactly like a single-scope `query`,
     * then `query.limit` (if given) is applied to the merged, sorted list.
     */
    queryAcrossScopes(scopes: readonly MemoryScope[], query?: MemoryQuery, requester?: MemoryPermissionRequester): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
    delete(scope: MemoryScope, id: MemoryEntryId, requester?: MemoryPermissionRequester): Promise<Result<boolean, RuntimeError>>;
    clear(scope: MemoryScope, requester?: MemoryPermissionRequester): Promise<Result<number, RuntimeError>>;
    /**
     * A convenience facade bound to one scope — the shape §17 of the brief
     * sketches as `context.memory.get(...)`/`context.memory.put(...)`.
     * `WorkflowContext.memory` (Stage 5's workflow integration, see
     * `workflow/workflow-context.ts`) is exactly `runtimeMemory.forScope(workflowScope(instanceId))`.
     * Never exposes `this.store` or any other unscoped access — a capability
     * or node handler holding a `ScopedRuntimeMemory` structurally cannot
     * name a different scope, which is what §17's "do NOT expose the
     * underlying persistence store directly to capabilities" actually
     * requires in code, not only in a doc comment.
     */
    forScope(scope: MemoryScope, requester?: MemoryPermissionRequester): ScopedRuntimeMemory;
}
/** One scope's worth of `RuntimeMemory`, with `scope` pre-bound — see `RuntimeMemory.forScope`. */
export interface ScopedRuntimeMemory {
    readonly scope: MemoryScope;
    put(input: Omit<MemoryWriteInput, 'scope'>): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>>;
    get(id: MemoryEntryId): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>>;
    query(query?: MemoryQuery): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
    delete(id: MemoryEntryId): Promise<Result<boolean, RuntimeError>>;
    clear(): Promise<Result<number, RuntimeError>>;
}
//# sourceMappingURL=runtime-memory.d.ts.map