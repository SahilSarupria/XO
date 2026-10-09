import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { MemoryEntryId } from '../ids.js';
import type { MemoryRecordStore, VersionedEnvelope } from '../persistence/runtime-store.interface.js';
import { InMemoryDurableMemoryStore } from './in-memory-durable-memory-store.js';
import { deriveMemoryEntryId, generateMemoryEntryId } from './memory-id.js';
import { allowAllMemoryPermissionGate, type MemoryPermissionGate, type MemoryPermissionRequester } from './memory-permission-gate.interface.js';
import { resolveExpiresAt } from './memory-ttl.js';
import type { MemoryEntry, MemoryQuery, MemoryScope, MemoryWriteInput } from './memory-types.js';
import { scopeKey } from './memory-types.js';

export interface RuntimeMemoryOptions {
  /** Defaults to `allowAllMemoryPermissionGate` — memory access is unrestricted unless a host explicitly wires in a real gate (typically `createPermissionManagerMemoryGate`), matching every other permission port in this package (§7). */
  readonly permissionGate?: MemoryPermissionGate;
  readonly now?: () => Date;
}

function permissionDenied(action: string, scope: MemoryScope, reason: string | undefined): RuntimeError {
  return new RuntimeError(ErrorCode.RUNTIME_PERMISSION_DENIED, `Memory "${action}" denied for scope "${scopeKey(scope)}"${reason ? `: ${reason}` : ''}`);
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
export class RuntimeMemory {
  private readonly permissionGate: MemoryPermissionGate;
  private readonly now: () => Date;

  constructor(
    private readonly store: MemoryRecordStore = new InMemoryDurableMemoryStore(),
    options: RuntimeMemoryOptions = {},
  ) {
    this.permissionGate = options.permissionGate ?? allowAllMemoryPermissionGate;
    this.now = options.now ?? (() => new Date());
  }

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
  async put(input: MemoryWriteInput, requester?: MemoryPermissionRequester): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>> {
    const verdict = await this.permissionGate.check('write', input.scope, requester);
    if (!verdict.allowed) return err(permissionDenied('write', input.scope, verdict.reason));

    const id = input.key !== undefined ? deriveMemoryEntryId(input.scope, input.key) : generateMemoryEntryId();
    const nowIso = this.now().toISOString();

    let createdAt = nowIso;
    if (input.key !== undefined) {
      const existing = await this.store.get(input.scope, id);
      if (!existing.ok) return existing;
      if (existing.value) createdAt = existing.value.data.createdAt;
    }

    const expiresAt = resolveExpiresAt(input, this.now);
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      type: input.type,
      ...(input.key !== undefined ? { key: input.key } : {}),
      value: input.value,
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt,
      updatedAt: nowIso,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    return this.store.put(entry);
  }

  async get(scope: MemoryScope, id: MemoryEntryId, requester?: MemoryPermissionRequester): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>> {
    const verdict = await this.permissionGate.check('read', scope, requester);
    if (!verdict.allowed) return err(permissionDenied('read', scope, verdict.reason));
    return this.store.get(scope, id);
  }

  /** Reads memory matching `query` within exactly one scope — never leaks into any other scope, even a related/broader one. Use {@link queryAcrossScopes} for the deliberate broader-scope case. */
  async query(scope: MemoryScope, query?: MemoryQuery, requester?: MemoryPermissionRequester): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>> {
    const verdict = await this.permissionGate.check('read', scope, requester);
    if (!verdict.allowed) return err(permissionDenied('read', scope, verdict.reason));
    return this.store.query(scope, query);
  }

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
  async queryAcrossScopes(scopes: readonly MemoryScope[], query?: MemoryQuery, requester?: MemoryPermissionRequester): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>> {
    const merged: VersionedEnvelope<MemoryEntry>[] = [];
    for (const scope of scopes) {
      const readVerdict = await this.permissionGate.check('read', scope, requester);
      if (!readVerdict.allowed) continue;
      if (scopes.length > 1) {
        const shareVerdict = await this.permissionGate.check('share', scope, requester);
        if (!shareVerdict.allowed) continue;
      }
      const { limit: _limit, ...rest } = query ?? {};
      const perScopeQuery = Object.keys(rest).length > 0 ? rest : undefined;
      const result = await this.store.query(scope, perScopeQuery);
      if (!result.ok) return result;
      merged.push(...result.value);
    }
    merged.sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt) || a.data.id.localeCompare(b.data.id));
    const limited = query?.limit !== undefined ? merged.slice(0, query.limit) : merged;
    return ok(limited);
  }

  async delete(scope: MemoryScope, id: MemoryEntryId, requester?: MemoryPermissionRequester): Promise<Result<boolean, RuntimeError>> {
    const verdict = await this.permissionGate.check('delete', scope, requester);
    if (!verdict.allowed) return err(permissionDenied('delete', scope, verdict.reason));
    return this.store.delete(scope, id);
  }

  async clear(scope: MemoryScope, requester?: MemoryPermissionRequester): Promise<Result<number, RuntimeError>> {
    const verdict = await this.permissionGate.check('delete', scope, requester);
    if (!verdict.allowed) return err(permissionDenied('delete', scope, verdict.reason));
    return this.store.clear(scope);
  }

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
  forScope(scope: MemoryScope, requester?: MemoryPermissionRequester): ScopedRuntimeMemory {
    return {
      scope,
      put: (input) => this.put({ ...input, scope }, requester),
      get: (id) => this.get(scope, id, requester),
      query: (query) => this.query(scope, query, requester),
      delete: (id) => this.delete(scope, id, requester),
      clear: () => this.clear(scope, requester),
    };
  }
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
