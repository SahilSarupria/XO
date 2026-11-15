/**
 * Domain Knowledge Packs (spec §4.6, §4.6.1): versioned, namespaced semantics plugged into a domain-agnostic core.
 *
 * A pack declares entity types, claim predicates and relationship types in ONE namespace, each with an optional schema
 * (a JSON-Schema subset, `schema.ts`). The core validates records against the pack that owns their namespace; it never
 * branches on a domain. A pack is identified by the digest of its content: an XO, a knowledge state or a workflow binds the
 * exact digest it was validated against, and resolution never substitutes another version — not the "latest", not one
 * installed later. Two packs claiming one namespace with different content are a conflict that is reported, never settled
 * by install order.
 */
import { digestOf, type Digest } from './canonical.js';
import { validateAgainstSchema, type SchemaNode } from './schema.js';
import type { PackBinding, TypeId } from './types.js';

export const PACK_SCHEMA = 'xo.domain-pack.v1';

export interface PackTypeDefinition {
  readonly name: string;
  readonly description?: string;
  /** Entity attributes, a claim's object value, or relationship metadata. Absent: any JSON value is accepted. */
  readonly schema?: SchemaNode;
}

export interface DomainPackManifest {
  readonly schema: typeof PACK_SCHEMA;
  readonly packId: string;
  readonly namespace: string;
  readonly version: string;
  /** The BKB core contract the pack was written for (`1`). */
  readonly compatibility: { readonly core: string };
  readonly dependencies: readonly { readonly packId: string; readonly digest: Digest; readonly optional?: boolean }[];
  readonly publisher: { readonly id: string; readonly name: string };
  readonly contributions: {
    readonly entityTypes: readonly PackTypeDefinition[];
    readonly predicates: readonly PackTypeDefinition[];
    readonly relationshipTypes: readonly PackTypeDefinition[];
  };
}

/** A pack as distributed: the manifest and the digest that identifies it (optionally signed by its publisher). */
export interface PackArtifact {
  readonly manifest: DomainPackManifest;
  readonly digest: Digest;
  readonly signature?: { readonly keyId: string; readonly value: string };
}

export const CORE_CONTRACT_VERSION = '1';
/** The core vocabulary namespace (generic: concept, rule, capability, relation kinds). It is not a domain. */
export const CORE_NAMESPACE = 'xo';

const NAMESPACE = /^[a-z][a-z0-9-]{1,40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function packDigest(manifest: DomainPackManifest): Digest {
  return digestOf(manifest);
}

export function makePackArtifact(manifest: DomainPackManifest): PackArtifact {
  return { manifest, digest: packDigest(manifest) };
}

/** Structural checks of a manifest; an artifact's digest must match its manifest. */
export function validatePackArtifact(artifact: PackArtifact): readonly string[] {
  const m = artifact.manifest;
  const problems: string[] = [];
  if (m.schema !== PACK_SCHEMA) problems.push(`unknown pack schema "${String(m.schema)}"`);
  if (!NAMESPACE.test(m.namespace)) problems.push(`namespace "${m.namespace}" is not a valid namespace`);
  if (m.namespace === CORE_NAMESPACE) problems.push(`namespace "${CORE_NAMESPACE}" is the core vocabulary; a pack cannot define it`);
  if (!SEMVER.test(m.version)) problems.push(`version "${m.version}" is not semantic`);
  if (m.compatibility.core !== CORE_CONTRACT_VERSION)
    problems.push(`the pack needs core contract ${m.compatibility.core}; this core is ${CORE_CONTRACT_VERSION}`);
  for (const group of ['entityTypes', 'predicates', 'relationshipTypes'] as const) {
    const names = m.contributions[group].map((t) => t.name);
    if (new Set(names).size !== names.length) problems.push(`${group} defines a name twice`);
  }
  if (packDigest(m) !== artifact.digest) problems.push('the pack digest does not match its manifest (altered or corrupt)');
  return problems;
}

export interface PackDependency {
  readonly packId: string;
  readonly namespace: string;
  readonly version: string;
  /** Exact content digest; a version alone never resolves. */
  readonly digest: Digest;
  readonly optional?: boolean;
}

export interface PackResolution {
  readonly resolved: readonly PackBinding[];
  readonly missing: readonly PackDependency[];
  readonly missingOptional: readonly PackDependency[];
  readonly conflicts: readonly string[];
  readonly invalid: readonly string[];
  /** True when every required dependency resolved to its exact digest and nothing conflicts. */
  readonly ok: boolean;
}

/**
 * Resolves `dependencies` against `available` packs by exact digest. A dependency whose digest is not available is missing
 * (blocking unless optional), even if another version of the same pack is; two available packs for one namespace that a
 * resolution would bind together are a conflict.
 */
export function resolvePackDependencies(dependencies: readonly PackDependency[], available: readonly PackArtifact[]): PackResolution {
  const byDigest = new Map(available.map((a) => [a.digest, a] as const));
  const resolved: PackBinding[] = [];
  const missing: PackDependency[] = [];
  const missingOptional: PackDependency[] = [];
  const invalid: string[] = [];
  for (const dep of dependencies) {
    const pack = byDigest.get(dep.digest);
    if (pack === undefined) {
      (dep.optional === true ? missingOptional : missing).push(dep);
      continue;
    }
    const problems = validatePackArtifact(pack);
    if (problems.length > 0 || pack.manifest.packId !== dep.packId || pack.manifest.namespace !== dep.namespace) {
      invalid.push(
        `${dep.packId}@${dep.digest}: ${problems.length > 0 ? problems.join('; ') : 'the pack at this digest has a different id or namespace'}`,
      );
      continue;
    }
    resolved.push({ packId: dep.packId, namespace: dep.namespace, version: pack.manifest.version, digest: dep.digest });
  }
  const conflicts: string[] = [];
  const byNs = new Map<string, Set<string>>();
  for (const b of resolved) byNs.set(b.namespace, new Set([...(byNs.get(b.namespace) ?? []), b.digest]));
  for (const [ns, digests] of byNs)
    if (digests.size > 1) conflicts.push(`namespace "${ns}" would be defined by ${digests.size} different packs; choose one explicitly`);
  return {
    resolved,
    missing,
    missingOptional,
    conflicts,
    invalid,
    ok: missing.length === 0 && conflicts.length === 0 && invalid.length === 0,
  };
}

/** The packs of a tenant, by namespace: exactly one pack per namespace may be active, chosen explicitly. */
export class PackSet {
  private readonly byNamespace = new Map<string, PackArtifact>();

  constructor(packs: readonly PackArtifact[] = []) {
    for (const p of packs) this.activate(p);
  }

  /** Activates `pack` for its namespace. Refuses a second, different pack for a namespace already active. */
  activate(pack: PackArtifact): void {
    const problems = validatePackArtifact(pack);
    if (problems.length > 0) throw new Error(`pack ${pack.manifest.packId}: ${problems.join('; ')}`);
    const existing = this.byNamespace.get(pack.manifest.namespace);
    if (existing !== undefined && existing.digest !== pack.digest)
      throw new Error(
        `namespace "${pack.manifest.namespace}" is already defined by ${existing.manifest.packId}@${existing.manifest.version} (${existing.digest}); deactivate it explicitly before activating ${pack.manifest.packId}@${pack.manifest.version}`,
      );
    this.byNamespace.set(pack.manifest.namespace, pack);
  }

  get(namespace: string): PackArtifact | undefined {
    return this.byNamespace.get(namespace);
  }

  bindings(): readonly PackBinding[] {
    return [...this.byNamespace.values()]
      .map((p) => ({ packId: p.manifest.packId, namespace: p.manifest.namespace, version: p.manifest.version, digest: p.digest }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }
}

export type TypeCheck =
  { readonly status: 'valid' } | { readonly status: 'unsupported' } | { readonly status: 'invalid'; readonly problems: readonly string[] };

/**
 * Checks a typed value against the pack that owns its namespace. The core namespace is generic and accepts any value; a
 * namespace no active pack defines is `unsupported` (stored and governed, not interpreted); a type the owning pack does not
 * declare, or a value its schema rejects, is `invalid`.
 */
export function checkTyped(packs: PackSet, group: keyof DomainPackManifest['contributions'], type: TypeId, value: unknown): TypeCheck {
  const ns = type.slice(0, type.indexOf(':'));
  if (ns === CORE_NAMESPACE) return { status: 'valid' };
  const pack = packs.get(ns);
  if (pack === undefined) return { status: 'unsupported' };
  const name = type.slice(ns.length + 1);
  const def = pack.manifest.contributions[group].find((t) => t.name === name);
  if (def === undefined)
    return { status: 'invalid', problems: [`${pack.manifest.packId}@${pack.manifest.version} does not declare ${group} "${name}"`] };
  if (def.schema === undefined) return { status: 'valid' };
  const problems = validateAgainstSchema(value, def.schema);
  return problems.length === 0 ? { status: 'valid' } : { status: 'invalid', problems };
}
