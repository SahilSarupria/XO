import type { PackageId } from '@xo/types';
import type { PermissionRequirement } from './capability-mapping.js';
import type { PermissionManager } from './manager.js';
import { parsePermissionId, type PermissionId } from './permission-id.js';
import { isAuthenticatedPrincipal, toPrincipalSnapshot, type AuthenticatedPrincipal, type Principal } from './principal.js';
import type { PermissionContext, PermissionRequester } from './request.js';

/**
 * P1.0 M2 — the single authoritative authorization decision.
 *
 * A protected capability execution is authorized from FOUR independent
 * inputs, none of which can stand in for another:
 *
 *   1. the SUBJECT — who is acting: an `AuthenticatedPrincipal` (API) or a
 *      `TrustedExecutionContext` (the local CLI operator). Never a
 *      capability id, package id, request field or `--grant` flag.
 *   2. the REQUESTER — which package/capability is asking (`PermissionRequester`).
 *   3. the DECLARATION — what that capability needs, resolved from
 *      authoritative metadata (never a caller-supplied list).
 *   4. the POLICY — `PermissionManager` (rules + grants), which decides each
 *      individual requirement.
 *
 * Everything here fails closed: a missing/invalid subject, a missing or
 * malformed declaration, a throwing policy, or any non-`allow` decision is
 * a denial returned as a value (never a thrown "allow").
 */

// ── Declarations ────────────────────────────────────────────────────────

/**
 * What a capability declares it needs. Three states, deliberately explicit:
 *
 *  - `required`   — one or more valid permissions.
 *  - `none`       — the declaration is PRESENT and says no permission is
 *                   needed (`requiredPermissions: []`). This is the only
 *                   representation of "permission-free".
 *  - `unresolved` — the declaration is missing, malformed, or conflicting.
 *                   NEVER treated as `none`; always denied.
 */
export type PermissionDeclaration =
  | { readonly kind: 'required'; readonly requirements: readonly PermissionRequirement[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unresolved'; readonly reason: string };

export const PERMISSION_FREE: PermissionDeclaration = Object.freeze({ kind: 'none' });

export function unresolvedDeclaration(reason: string): PermissionDeclaration {
  return Object.freeze({ kind: 'unresolved', reason });
}

/**
 * Resolves an authoritative `requiredPermissions` value (e.g. a capability
 * node's property, an `execution.requiredPermissionIds` array) into a
 * {@link PermissionDeclaration}. `undefined`/`null` (declaration absent) is
 * `unresolved` — it is NOT the same as an empty array.
 */
export function resolveDeclaredPermissionIds(raw: unknown, source: string): PermissionDeclaration {
  if (raw === undefined || raw === null)
    return unresolvedDeclaration(
      `${source}: permission declaration is missing (declare \`[]\` explicitly for a permission-free capability)`,
    );
  if (!Array.isArray(raw)) return unresolvedDeclaration(`${source}: permission declaration must be an array of permission ids`);
  if (raw.length === 0) return PERMISSION_FREE;

  const requirements: PermissionRequirement[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') return unresolvedDeclaration(`${source}: permission declaration contains a non-string entry`);
    const parsed = parsePermissionId(value);
    if (!parsed.ok) return unresolvedDeclaration(`${source}: "${value}" is not a valid permission id (${parsed.error})`);
    if (seen.has(parsed.value.id)) continue;
    seen.add(parsed.value.id);
    requirements.push({ permission: parsed.value.id });
  }
  return Object.freeze({ kind: 'required', requirements: Object.freeze(requirements) });
}

// ── Authoritative provenance ────────────────────────────────────────────

/**
 * Where an authoritative declaration was read from. Each is a TRUSTED, host-side
 * source — never a request body, header, CLI flag or deserialized JSON:
 *
 *  - `persisted-xoir-node`          the `requiredPermissions` property of a capability
 *                                   node in the PERSISTED compiled graph.
 *  - `installed-package-manifest`   the installed `.xo` package's own manifest declaration.
 *  - `trusted-host-registration`    a host that registers its own native capability (and
 *                                   trusted test/evaluation harnesses acting as that host).
 */
export type AuthoritativeDeclarationOrigin = 'persisted-xoir-node' | 'installed-package-manifest' | 'trusted-host-registration';

const AUTHORITATIVE_ORIGINS: ReadonlySet<string> = new Set<AuthoritativeDeclarationOrigin>([
  'persisted-xoir-node',
  'installed-package-manifest',
  'trusted-host-registration',
]);

interface DeclarationProvenance {
  readonly capabilityId: string;
  readonly origin: AuthoritativeDeclarationOrigin;
}

/**
 * Module-private mint registry. A declaration is "authoritative" iff THIS
 * object identity was returned by {@link resolveAuthoritativeDeclaration}.
 * A structurally identical object literal, a `JSON.parse` copy, a spread, a
 * cast (`as PermissionDeclaration`) or the shared {@link PERMISSION_FREE}
 * constant is NOT in the map and does not verify — TypeScript types alone
 * never establish this. Same in-process guarantee (and same documented limit)
 * as `establishAuthenticatedPrincipal`: the trust boundary is which code calls
 * the factory, and each host has one reviewable call site.
 */
const authoritativeDeclarations = new WeakMap<object, DeclarationProvenance>();

/**
 * Resolves a capability's permission declaration FROM AN AUTHORITATIVE SOURCE
 * and mints it for exactly that capability. The result is a normal
 * {@link PermissionDeclaration} (`required` / `none` / `unresolved`), additionally
 * recorded as authoritative-for-`capabilityId` so an execution boundary can
 * verify provenance with {@link isAuthoritativeDeclarationFor}.
 *
 * `raw` follows {@link resolveDeclaredPermissionIds}: absent/malformed is
 * `unresolved` (still minted — it is authoritatively unresolved — and denied
 * downstream); only an explicit `[]` is permission-free. A fresh object is
 * minted per call so one capability's permission-free declaration can never be
 * replayed for another.
 */
export function resolveAuthoritativeDeclaration(
  raw: unknown,
  provenance: { readonly capabilityId: string; readonly origin: AuthoritativeDeclarationOrigin; readonly source?: string },
): PermissionDeclaration {
  const source = provenance.source ?? `capability "${String(provenance.capabilityId)}" requiredPermissions`;
  return attestAuthoritativeDeclaration(resolveDeclaredPermissionIds(raw, source), provenance);
}

/**
 * Mints an already-resolved declaration as authoritative for `capabilityId`.
 * For a trusted host that COMPOSES one declaration from several of its own
 * authoritative sources (the CLI: package property bag + manifest + execution
 * block, including scoped requirements) and so cannot hand
 * {@link resolveAuthoritativeDeclaration} a single raw id list. The input must
 * already have been derived from those sources by the host — never from a
 * request or a caller-supplied value. Always returns a FRESH frozen object
 * (the input, including the shared {@link PERMISSION_FREE}, is never minted
 * itself), so a minted declaration cannot be replayed for another capability.
 */
export function attestAuthoritativeDeclaration(
  resolved: PermissionDeclaration,
  provenance: { readonly capabilityId: string; readonly origin: AuthoritativeDeclarationOrigin; readonly source?: string },
): PermissionDeclaration {
  if (
    typeof provenance.capabilityId !== 'string' ||
    provenance.capabilityId.length === 0 ||
    !AUTHORITATIVE_ORIGINS.has(provenance.origin)
  ) {
    // Not mintable: returned un-minted, so it can never verify as authoritative.
    return unresolvedDeclaration('an authoritative declaration needs a capability id and a trusted origin');
  }
  const minted: PermissionDeclaration =
    resolved !== null && typeof resolved === 'object' && resolved.kind === 'required' && Array.isArray(resolved.requirements)
      ? Object.freeze({ kind: 'required', requirements: Object.freeze([...resolved.requirements]) })
      : resolved !== null && typeof resolved === 'object' && resolved.kind === 'none'
        ? Object.freeze({ kind: 'none' })
        : Object.freeze({
            kind: 'unresolved',
            reason:
              resolved !== null && typeof resolved === 'object' && resolved.kind === 'unresolved' ? resolved.reason : 'invalid declaration',
          });
  authoritativeDeclarations.set(minted, { capabilityId: provenance.capabilityId, origin: provenance.origin });
  return minted;
}

/** True iff `declaration` was minted by {@link resolveAuthoritativeDeclaration} for exactly `capabilityId`. */
export function isAuthoritativeDeclarationFor(declaration: unknown, capabilityId: string): declaration is PermissionDeclaration {
  if (typeof declaration !== 'object' || declaration === null) return false;
  const provenance = authoritativeDeclarations.get(declaration);
  return provenance !== undefined && provenance.capabilityId === capabilityId;
}

function declaredPermissionSet(declaration: PermissionDeclaration): ReadonlySet<string> | undefined {
  if (declaration.kind === 'none') return new Set();
  if (declaration.kind === 'required') return new Set(declaration.requirements.map((r) => r.permission as string));
  return undefined;
}

/**
 * Cross-checks an authoritative declaration against a second declared copy
 * of the same requirement (e.g. the contract embedded in the same node).
 * Two declarations that disagree are `unresolved` ("conflicting") — the
 * system never picks the more permissive one.
 */
export function reconcilePermissionDeclarations(
  primary: PermissionDeclaration,
  secondary: PermissionDeclaration,
  source: string,
): PermissionDeclaration {
  if (primary.kind === 'unresolved') return primary;
  if (secondary.kind === 'unresolved') return unresolvedDeclaration(`${source}: ${secondary.reason}`);
  const a = declaredPermissionSet(primary);
  const b = declaredPermissionSet(secondary);
  if (a === undefined || b === undefined || a.size !== b.size || [...a].some((id) => !b.has(id))) {
    return unresolvedDeclaration(
      `${source}: conflicting permission declarations (${[...(a ?? [])].sort().join(',') || '∅'} vs ${[...(b ?? [])].sort().join(',') || '∅'})`,
    );
  }
  return primary;
}

/**
 * The authoritative declaration `declaration` may ADD requirements beyond a
 * second declared copy `copy` (e.g. a manifest making a capability stricter
 * than the contract embedded in its graph) but may never DROP or contradict
 * one: if `copy` names a permission `declaration` lacks, that is a conflict
 * and the result is `unresolved`. Never resolves to the more permissive of
 * the two.
 */
export function declarationCoversCopy(
  declaration: PermissionDeclaration,
  copy: PermissionDeclaration,
  source: string,
): PermissionDeclaration {
  if (declaration.kind === 'unresolved') return declaration;
  if (copy.kind === 'unresolved') return unresolvedDeclaration(`${source}: ${copy.reason}`);
  const have = declaredPermissionSet(declaration);
  const need = declaredPermissionSet(copy);
  if (have === undefined || need === undefined) return unresolvedDeclaration(`${source}: permission declarations could not be compared`);
  const missing = [...need].filter((id) => !have.has(id));
  if (missing.length > 0)
    return unresolvedDeclaration(
      `${source}: conflicting permission declarations (the contract requires ${missing.sort().join(', ')}, which the authoritative declaration omits)`,
    );
  return declaration;
}

// ── Subject: authenticated principal or trusted execution context ──────

/**
 * A non-principal trusted caller of a lower-level abstraction. Today there
 * are two kinds: `local-operator`, the CLI user who already has local
 * shell/filesystem access to the data they are operating on. It is NOT an
 * identity: it carries no id, matches no principal-scoped rule, and is not
 * evidence of any particular person.
 *
 * Like `AuthenticatedPrincipal`, it is only ever created by
 * {@link establishTrustedExecutionContext} and re-verified by
 * {@link isTrustedExecutionContext}; a structural copy, JSON, header, body
 * field or flag does not verify. Same documented limitation as M1: an
 * in-process guarantee — the trust boundary is "which code calls the
 * factory" (one reviewable call site per host: the CLI entry command).
 */
export type TrustedExecutionContextKind = 'local-operator' | 'evaluation-harness';

declare const trustedBrand: unique symbol;
export interface TrustedExecutionContext {
  readonly kind: 'trusted-context';
  readonly context: TrustedExecutionContextKind;
  readonly [trustedBrand]: true;
}

const trustedContexts = new WeakSet<object>();

export function establishTrustedExecutionContext(context: TrustedExecutionContextKind): TrustedExecutionContext {
  if (context !== 'local-operator' && context !== 'evaluation-harness')
    throw new Error(`unknown trusted execution context "${String(context)}"`);
  const minted = Object.freeze({ kind: 'trusted-context', context }) as unknown as TrustedExecutionContext;
  trustedContexts.add(minted);
  return minted;
}

export function isTrustedExecutionContext(value: unknown): value is TrustedExecutionContext {
  return typeof value === 'object' && value !== null && trustedContexts.has(value);
}

export type AuthorizationSubject = AuthenticatedPrincipal | TrustedExecutionContext;

export function isAuthorizationSubject(value: unknown): value is AuthorizationSubject {
  return isAuthenticatedPrincipal(value) || isTrustedExecutionContext(value);
}

/** The attribution snapshot for a subject that has one (principals only). */
export function subjectPrincipal(subject: AuthorizationSubject): Principal | undefined {
  return isAuthenticatedPrincipal(subject) ? toPrincipalSnapshot(subject) : undefined;
}

// ── The decision ────────────────────────────────────────────────────────

export type AuthorizationDenialCode =
  | 'no-policy'
  | 'no-subject'
  | 'no-requester'
  | 'unresolved-declaration'
  | 'permission-denied'
  | 'evaluation-error';

export type AuthorizationOutcome =
  | { readonly allowed: true; readonly checked: readonly PermissionRequirement[] }
  | { readonly allowed: false; readonly code: AuthorizationDenialCode; readonly reason: string; readonly permission?: PermissionId };

export interface AuthorizeCapabilityExecutionInput {
  /** The policy decision point. Absent/invalid ⇒ deny (`no-policy`). */
  readonly manager: PermissionManager | undefined;
  /** Verified at runtime — an unverifiable value (forged object, plain `Principal`, string) is denied. */
  readonly subject: unknown;
  readonly requester: PermissionRequester;
  /** Resolved from authoritative metadata. Absent/`unresolved` ⇒ deny. */
  readonly declaration: PermissionDeclaration | undefined;
  readonly context?: PermissionContext;
}

function deny(code: AuthorizationDenialCode, reason: string, permission?: PermissionId): AuthorizationOutcome {
  return { allowed: false, code, reason, ...(permission !== undefined ? { permission } : {}) };
}

/**
 * Authorizes ONE protected capability execution. Never throws: every
 * failure is a `deny` value. `prompt` decisions are denials here (an
 * execution cannot pause for consent), as everywhere else in the runtime.
 *
 * A permission-free capability (`none`) still requires a verified subject —
 * "no permissions needed" never means "no actor needed".
 */
export async function authorizeCapabilityExecution(input: AuthorizeCapabilityExecutionInput): Promise<AuthorizationOutcome> {
  try {
    if (input.manager === undefined || input.manager === null || typeof input.manager.check !== 'function') {
      return deny('no-policy', 'no authorization policy is configured — execution is denied by default');
    }
    if (!isAuthorizationSubject(input.subject)) {
      return deny('no-subject', 'no verified authenticated principal or trusted execution context — execution is denied');
    }
    const requester = input.requester;
    if (
      typeof requester !== 'object' ||
      requester === null ||
      typeof requester.packageId !== 'string' ||
      (requester.packageId as string).length === 0 ||
      typeof requester.capabilityId !== 'string' ||
      requester.capabilityId.length === 0
    ) {
      return deny('no-requester', 'the requesting package/capability identity is missing');
    }

    const declaration = input.declaration;
    if (declaration === undefined || declaration === null || typeof declaration !== 'object') {
      return deny(
        'unresolved-declaration',
        `capability "${requester.capabilityId}" has no permission declaration — missing requirements are never treated as unrestricted`,
      );
    }
    if (declaration.kind === 'unresolved') {
      return deny('unresolved-declaration', `capability "${requester.capabilityId}" cannot be authorized: ${declaration.reason}`);
    }
    if (declaration.kind === 'none') return { allowed: true, checked: [] };
    if (declaration.kind !== 'required' || !Array.isArray(declaration.requirements) || declaration.requirements.length === 0) {
      return deny('unresolved-declaration', `capability "${requester.capabilityId}" has an invalid permission declaration`);
    }

    const principal = subjectPrincipal(input.subject);
    for (const requirement of declaration.requirements) {
      const decision = await input.manager.check({
        permission: requirement.permission,
        ...(requirement.scope !== undefined ? { scope: requirement.scope } : {}),
        requester: { packageId: requester.packageId as PackageId, capabilityId: requester.capabilityId },
        ...(principal !== undefined ? { principal } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (decision.effect !== 'allow') {
        if (requirement.optional === true) continue;
        return deny(
          'permission-denied',
          `permission "${requirement.permission}" required by capability "${requester.capabilityId}" was not granted: ${decision.reason}`,
          requirement.permission,
        );
      }
    }
    return { allowed: true, checked: declaration.requirements };
  } catch (cause) {
    return deny(
      'evaluation-error',
      `authorization could not be evaluated (${cause instanceof Error ? cause.message : String(cause)}) — denied`,
    );
  }
}
