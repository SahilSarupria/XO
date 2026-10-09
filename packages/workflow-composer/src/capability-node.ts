import type { XoirNode } from '@xo/xoir';

/**
 * Defensive, runtime-checked readers over a `capability`-kind XOIR node's
 * `properties` bag. `CapabilityNodeProps` (`@xo/xoir`'s `node-kinds.ts`)
 * types these fields precisely, but a `XoirNode` handed to this package
 * generically is only known to be `XoirNode<'capability'>` at the value
 * level (a `subgraph()`/`filterNodes()` result loses the specific
 * `CapabilityNodeProps` generic parameter) — these helpers narrow with
 * real runtime checks instead of an unchecked cast, and return
 * `undefined` rather than throwing or guessing whenever a field is
 * absent or shaped unexpectedly.
 */

export function getCapabilityName(node: XoirNode): string {
  const value = node.properties['name'];
  return typeof value === 'string' && value.length > 0 ? value : node.id;
}

export function getCapabilityDescription(node: XoirNode): string {
  const value = node.properties['description'];
  return typeof value === 'string' ? value : '';
}

/** Mirror of `CapabilityNodeProps.dependencies` — other capability node ids this one's *own properties* claim to depend on, independent of what edges the graph actually carries (see `compose.ts`'s cross-check against real `REQUIRES` edges). */
export function getDeclaredDependencies(node: XoirNode): readonly string[] {
  const value = node.properties['dependencies'];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * The embedded `SemanticCapabilityContract.id`, when `@xo/compiler`
 * embedded one (`CapabilityNodeProps.semanticCapabilityContract`). This
 * package deliberately does not depend on `@xo/capability-contract` and
 * does not parse the rest of the contract — it only cites the id for
 * traceability, per the same "read, don't re-derive" discipline the
 * contract's own doc comment describes.
 */
export function getEmbeddedContractId(node: XoirNode): string | undefined {
  const contract = node.properties['semanticCapabilityContract'];
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) return undefined;
  const id = (contract as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
}
