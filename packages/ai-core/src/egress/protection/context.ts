/**
 * UW-14e — which workspace's protection applies to the model call being made. The host runs each piece of workspace work inside
 * `runWithProtection` (the API does it for every /workspaces/{id}/… request and every scheduled run); the egress guard reads it when
 * a request is about to leave. A hosted request with no protection context is refused in `masked_hosted` (fail-closed) and scanned
 * with the pattern packs alone otherwise.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ProtectionScanner, type LeakVerdict } from './scanner.js';

export interface ProtectionContext {
  /** The workspace (tenant) whose values are protected. */
  readonly scope: string;
  /** The scanner with this workspace's known-value dictionary (built lazily, only when a request is about to leave). */
  scanner(): Promise<ProtectionScanner>;
  /** Told when the leak guard blocks a request (to audit it: hashes only). */
  onBlocked?(verdict: LeakVerdict, about: { readonly providerId: string }): void | Promise<void>;
}

const storage = new AsyncLocalStorage<ProtectionContext>();

export function runWithProtection<T>(ctx: ProtectionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentProtection(): ProtectionContext | undefined {
  return storage.getStore();
}

/** Patterns only: what applies when no workspace context is set. */
export const PATTERN_ONLY_SCANNER = new ProtectionScanner();
