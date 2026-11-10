/**
 * INTERNAL (not re-exported from index.ts; the package `exports` map blocks deep imports).
 * The registry of trusted actor references lives here so both `event.ts` (public minting API) and the chained store
 * (re-validation of already-persisted, previously-trusted events) share ONE WeakSet without exposing a minting
 * function to application code.
 */
import type { AuditActorFields } from './event.js';

const minted = new WeakSet<object>();

export function mintActorInternal<T extends AuditActorFields>(fields: T): T & { readonly __auditActor: true } {
  const actor = Object.freeze({ ...fields }) as T & { readonly __auditActor: true };
  minted.add(actor);
  return actor;
}

export function isMintedActor(value: unknown): boolean {
  return typeof value === 'object' && value !== null && minted.has(value);
}
