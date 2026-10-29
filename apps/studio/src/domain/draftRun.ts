import type { Capability, InputContract } from '../platform/wire';

/**
 * The details a draft run asks for: the union of what each step's published input contract declares, so one form
 * covers the whole run. Returns undefined (use the JSON fallback) when any step has no published contract or two
 * steps declare the same name with different types. Presentation only; the platform validates the input against the
 * steps' real contracts and may still refuse it.
 */
export function mergeInputContracts(caps: readonly (Capability | undefined)[]): InputContract | undefined {
  const properties: Record<string, { type: InputContract['properties'][string]['type'] }> = {};
  const required = new Set<string>();
  for (const c of caps) {
    if (c?.inputContract === undefined) return undefined;
    for (const [name, def] of Object.entries(c.inputContract.properties)) {
      const have = properties[name];
      if (have !== undefined && have.type !== def.type) return undefined;
      properties[name] = { type: def.type };
    }
    for (const r of c.inputContract.required) required.add(r);
  }
  return { properties, required: [...required] };
}
