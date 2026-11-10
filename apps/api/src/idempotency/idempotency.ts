import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { ErrorCode, XoError } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { canonicalStringify, type XoirValue } from '@xo/xoir';
import type { AtomicBlobStore } from '@xo/storage';

/**
 * P1.0 M6 — Idempotency for the two side-effecting operations that START work: `POST .../executions` (`execute.capability`) and
 * `POST .../workflows/:id/executions` (`start.workflow`).
 *
 * WHAT IS GUARANTEED (and what is not) is stated in `apps/api/README.md` "Idempotency (P1.0 M6)". In short: for a request that
 * carries an `Idempotency-Key`, within one workspace + principal + operation, the operation's side effects are STARTED AT MOST
 * ONCE per key; a retry gets the recorded resource back instead of a second run; an interrupted run whose outcome cannot be
 * proven is refused, never re-run and never reported as success. Exactly-once execution of the capability itself is NOT claimed.
 *
 * The key is optional (requests without it behave exactly as before). Nothing here grants anything: the caller has ALREADY passed
 * ownership (M1), authorization (M2) and approval (M3) checks before a record is consulted, on every request including retries.
 */

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type IdempotentOperation = 'execute.capability' | 'start.workflow' | 'start.procedure';
export type IdempotentResourceKind = 'execution' | 'workflow-execution' | 'procedure-execution';

export interface IdempotentResource {
  readonly kind: IdempotentResourceKind;
  readonly id: string;
}

export interface IdempotencyPrincipal {
  readonly kind: 'human' | 'service';
  readonly id: string;
}

export type IdempotencyState = 'in_progress' | 'completed';

/**
 * The durable record. It stores NO request payload and NOT the client's key: only hashes (the scope hash covers
 * operation + workspace + principal + key; the fingerprint covers the request) and the id of the resource the operation created.
 */
export interface IdempotencyRecord {
  readonly schemaVersion: 1;
  readonly operation: IdempotentOperation;
  readonly workspaceId: string;
  readonly principal: IdempotencyPrincipal;
  readonly scopeHash: string;
  readonly fingerprint: string;
  readonly state: IdempotencyState;
  readonly claimedAt: string;
  readonly updatedAt: string;
  readonly resource?: IdempotentResource;
}

/** The header is read once; a malformed or repeated one is a 400 and its value is never echoed. */
export function readIdempotencyKey(headers: IncomingHttpHeaders): Result<string | undefined, XoError> {
  const raw = headers[IDEMPOTENCY_KEY_HEADER];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    return err(
      new XoError(
        ErrorCode.INVALID_ARGUMENT,
        'Idempotency-Key must be given once, 8-128 characters of [A-Za-z0-9._:-], starting with a letter or digit',
      ),
    );
  }
  return ok(raw);
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Unambiguous (length-prefixed) so no two distinct tuples can collide by concatenation. */
export function scopeHashOf(operation: IdempotentOperation, workspaceId: string, principal: IdempotencyPrincipal, key: string): string {
  const parts = ['xo.idempotency.scope.v1', operation, workspaceId, principal.kind, principal.id, key];
  return sha256(parts.map((p) => `${p.length}:${p}`).join('|'));
}

/** Equivalence of two requests = equality of this value. Includes the operation and every field that selects the work. */
export function fingerprintRequest(operation: IdempotentOperation, request: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalStringify({ schema: 'xo.idempotency.request.v1', operation, request } as unknown as XoirValue));
}

export const keyRefOf = (scopeHash: string): string => scopeHash.slice(0, 16);
const storageKeyOf = (operation: IdempotentOperation, scopeHash: string): string => `${operation}/${scopeHash}.json`;

const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'operation',
  'workspaceId',
  'principal',
  'scopeHash',
  'fingerprint',
  'state',
  'claimedAt',
  'updatedAt',
  'resource',
]);

/** Strict: unknown fields, wrong types or a state/resource combination that cannot occur are `undefined` (=> fail closed). */
export function parseIdempotencyRecord(raw: unknown): IdempotencyRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !RECORD_KEYS.has(k))) return undefined;
  if (o['schemaVersion'] !== 1) return undefined;
  if (o['operation'] !== 'execute.capability' && o['operation'] !== 'start.workflow' && o['operation'] !== 'start.procedure')
    return undefined;
  if (typeof o['workspaceId'] !== 'string' || o['workspaceId'].length === 0) return undefined;
  const p = o['principal'] as Record<string, unknown> | null | undefined;
  if (typeof p !== 'object' || p === null) return undefined;
  if (Object.keys(p).some((k) => k !== 'kind' && k !== 'id')) return undefined;
  if ((p['kind'] !== 'human' && p['kind'] !== 'service') || typeof p['id'] !== 'string' || p['id'].length === 0) return undefined;
  if (typeof o['scopeHash'] !== 'string' || !HEX64.test(o['scopeHash'])) return undefined;
  if (typeof o['fingerprint'] !== 'string' || !HEX64.test(o['fingerprint'])) return undefined;
  if (o['state'] !== 'in_progress' && o['state'] !== 'completed') return undefined;
  if (typeof o['claimedAt'] !== 'string' || typeof o['updatedAt'] !== 'string') return undefined;
  let resource: IdempotentResource | undefined;
  if (o['resource'] !== undefined) {
    const r = o['resource'] as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null) return undefined;
    if (Object.keys(r).some((k) => k !== 'kind' && k !== 'id')) return undefined;
    if (
      (r['kind'] !== 'execution' && r['kind'] !== 'workflow-execution' && r['kind'] !== 'procedure-execution') ||
      typeof r['id'] !== 'string' ||
      r['id'].length === 0
    )
      return undefined;
    resource = { kind: r['kind'], id: r['id'] };
  }
  if (o['state'] === 'completed' && resource === undefined) return undefined; // a completed operation always names what it created
  return {
    schemaVersion: 1,
    operation: o['operation'],
    workspaceId: o['workspaceId'],
    principal: { kind: p['kind'], id: p['id'] },
    scopeHash: o['scopeHash'],
    fingerprint: o['fingerprint'],
    state: o['state'],
    claimedAt: o['claimedAt'],
    updatedAt: o['updatedAt'],
    ...(resource !== undefined ? { resource } : {}),
  };
}

// ── in-process coordination ────────────────────────────────────────────

/**
 * Serializes the DECISION part of a claim (read -> decide -> write) per key within this process, and removes its bookkeeping when
 * idle (unlike `withExecutionLock`, whose map only grows — unsuitable for one entry per client-chosen key). The long-running
 * operation itself is NOT run under it. In-process only, matching the repo's single-process model; see the README limits.
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

const mutex = new KeyedMutex();
/**
 * Claims whose operation is running RIGHT NOW in this process. A stored `in_progress` record that is not in this set has no live
 * owner here (it was left by a previous process, or by a request that died): that is what makes it recoverable-by-rule.
 */
const liveClaims = new Set<string>();

/** Test hook: how many claims are live in this process. */
export function liveClaimCount(): number {
  return liveClaims.size;
}

// ── the gate ───────────────────────────────────────────────────────────

/** Answers, for a claim that already names a resource: how far did the original attempt get? Supplied by the route (it owns the stores). */
export type ResourceProbe = (resource: IdempotentResource) => Promise<'done' | 'unfinished' | 'absent' | 'foreign'>;

export interface BeginInput {
  readonly operation: IdempotentOperation;
  readonly workspaceId: string;
  readonly principal: IdempotencyPrincipal;
  readonly key: string;
  readonly fingerprint: string;
  readonly probe: ResourceProbe;
  readonly now?: () => string;
}

export type BeginOutcome =
  | { readonly kind: 'proceed'; readonly claim: IdempotencyClaim; readonly keyRef: string; readonly takeover: boolean }
  | { readonly kind: 'replay'; readonly resource: IdempotentResource; readonly keyRef: string; readonly recovered: boolean }
  | { readonly kind: 'conflict'; readonly keyRef: string }
  | { readonly kind: 'in_progress'; readonly keyRef: string }
  | { readonly kind: 'outcome_unknown'; readonly resource: IdempotentResource; readonly keyRef: string }
  | { readonly kind: 'invalid_record'; readonly keyRef: string }
  | { readonly kind: 'unavailable'; readonly keyRef: string; readonly error: XoError };

type ReadResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'record'; readonly record: IdempotencyRecord }
  | { readonly kind: 'error'; readonly error: XoError };

export class IdempotencyGate {
  constructor(private readonly store: AtomicBlobStore) {}

  private async read(path: string): Promise<ReadResult> {
    const raw = await this.store.get(path);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND && !(await this.store.has(path))) return { kind: 'none' };
      return { kind: 'error', error: raw.error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.value));
    } catch {
      return { kind: 'invalid' };
    }
    const record = parseIdempotencyRecord(parsed);
    return record === undefined ? { kind: 'invalid' } : { kind: 'record', record };
  }

  async begin(input: BeginInput): Promise<BeginOutcome> {
    const scopeHash = scopeHashOf(input.operation, input.workspaceId, input.principal, input.key);
    const keyRef = keyRefOf(scopeHash);
    const path = storageKeyOf(input.operation, scopeHash);
    const now = input.now ?? (() => new Date().toISOString());
    const unavailable = (error: XoError): BeginOutcome => ({ kind: 'unavailable', keyRef, error });

    return mutex.run(path, async (): Promise<BeginOutcome> => {
      const fresh = (): IdempotencyRecord => ({
        schemaVersion: 1,
        operation: input.operation,
        workspaceId: input.workspaceId,
        principal: { kind: input.principal.kind, id: input.principal.id },
        scopeHash,
        fingerprint: input.fingerprint,
        state: 'in_progress',
        claimedAt: now(),
        updatedAt: now(),
      });
      const claimFor = (record: IdempotencyRecord, takeover: boolean): BeginOutcome => {
        liveClaims.add(path);
        return { kind: 'proceed', claim: new IdempotencyClaim(this.store, path, record, now), keyRef, takeover };
      };

      let found = await this.read(path);
      if (found.kind === 'none') {
        const record = fresh();
        const created = await this.store.putIfAbsent(path, JSON.stringify(record), { contentType: 'application/json' });
        if (!created.ok) return unavailable(created.error);
        if (created.value.created) return claimFor(record, false);
        found = await this.read(path); // another process won the create: judge ITS record, never overwrite it
      }
      if (found.kind === 'error') return unavailable(found.error);
      if (found.kind === 'none' || found.kind === 'invalid') return { kind: 'invalid_record', keyRef };

      const existing = found.record;
      // The record must be the one for THIS scope. A copied/renamed/tampered file for another workspace, principal,
      // operation or key is never honoured and never disclosed.
      if (
        existing.scopeHash !== scopeHash ||
        existing.operation !== input.operation ||
        existing.workspaceId !== input.workspaceId ||
        existing.principal.id !== input.principal.id ||
        existing.principal.kind !== input.principal.kind
      ) {
        return { kind: 'invalid_record', keyRef };
      }
      if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict', keyRef };
      if (existing.state === 'completed') {
        return existing.resource === undefined
          ? { kind: 'invalid_record', keyRef }
          : { kind: 'replay', resource: existing.resource, keyRef, recovered: false };
      }
      if (liveClaims.has(path)) return { kind: 'in_progress', keyRef };

      // ── in_progress with no live owner: recovery by rule ──────────────────────────────────────────────
      // (a) never got as far as naming a resource  => its side effects cannot have started => safe to take over.
      // (b) named a resource: ask the resource what happened.
      //       absent     — the id was reserved but the record never created  => nothing ran => safe to take over;
      //       done       — it ran to its recorded end                        => adopt it as completed (never re-run);
      //       unfinished — it started and its end cannot be proven            => REFUSE (never re-run, never call it a success);
      //       foreign    — it is not this principal's resource               => fail closed.
      if (existing.resource !== undefined) {
        const probed = await input.probe(existing.resource);
        if (probed === 'foreign') return { kind: 'invalid_record', keyRef };
        if (probed === 'unfinished') return { kind: 'outcome_unknown', resource: existing.resource, keyRef };
        if (probed === 'done') {
          const adopted: IdempotencyRecord = { ...existing, state: 'completed', updatedAt: now() };
          const written = await this.store.replace(path, JSON.stringify(adopted), { contentType: 'application/json' });
          if (!written.ok) return unavailable(written.error);
          return { kind: 'replay', resource: existing.resource, keyRef, recovered: true };
        }
      }
      const taken = { ...fresh(), claimedAt: existing.claimedAt };
      const written = await this.store.replace(path, JSON.stringify(taken), { contentType: 'application/json' });
      if (!written.ok) return unavailable(written.error);
      return claimFor(taken, true);
    });
  }
}

/**
 * The live owner's handle. Every method is safe to call more than once and NEVER throws: the caller decides what a `false` means
 * (see each method). `dispose()` must always be reached (`finally`) so a request that dies cannot leave the claim looking live.
 */
export class IdempotencyClaim {
  private current: IdempotencyRecord;
  private live = true;
  constructor(
    private readonly store: AtomicBlobStore,
    private readonly path: string,
    record: IdempotencyRecord,
    private readonly now: () => string,
  ) {
    this.current = record;
  }

  private async write(next: IdempotencyRecord): Promise<boolean> {
    try {
      const written = await this.store.replace(this.path, JSON.stringify(next), { contentType: 'application/json' });
      if (written.ok) this.current = next;
      return written.ok;
    } catch {
      return false;
    }
  }

  /** Durably NAMES the resource about to be created, BEFORE it exists. `false` => abort before creating anything. */
  attach(resource: IdempotentResource): Promise<boolean> {
    return this.write({ ...this.current, resource, updatedAt: this.now() });
  }

  /** The operation reached its recorded end. `false` => the work happened but the record could not say so; a retry will adopt it via the probe. */
  async complete(): Promise<boolean> {
    if (this.current.resource === undefined) return false;
    const ok = await this.write({ ...this.current, state: 'completed', updatedAt: this.now() });
    this.dispose();
    return ok;
  }

  /**
   * The attempt failed. If nothing it names was created (no resource, or the resource is `absent`), the claim is deleted so the
   * client can retry the same key. Otherwise it is LEFT in_progress for the recovery rules: the side effects may have started.
   */
  async abort(probe: ResourceProbe): Promise<void> {
    try {
      let releasable = this.current.resource === undefined;
      if (!releasable && this.current.resource !== undefined) releasable = (await probe(this.current.resource)) === 'absent';
      if (releasable) await this.store.delete(this.path);
    } catch {
      /* leave it: recovery handles an in_progress record with no live owner */
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.live) {
      this.live = false;
      liveClaims.delete(this.path);
    }
  }
}
