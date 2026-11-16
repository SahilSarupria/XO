import type { SemanticCapabilityContract } from './types.js';

/**
 * UW-7 (ADR 0033) — what a capability does to the world (its effect class) and the typed shape of what it returns, read off a
 * contract and, for an external capability, the operator's binding. Both are DERIVED, never stored on the contract: deriving them
 * keeps every existing contract hash unchanged, and the capability inventory records them (so they are bound into the inventory
 * digest, and from there into readiness certificates).
 *
 * Fail closed: a capability whose effect cannot be established is `unknown`, and `mayChangeTheWorld` treats `unknown` as a write.
 * Nothing here is guessed from wording: the source's prose describing an action makes the class `unknown`, not `write`.
 */

/**
 *  - none: evaluates rules and returns a result; it changes nothing outside the run;
 *  - human: a person does the work (a human task); XO itself sends nothing;
 *  - read / write / irreversible: an external operation, as the operator's binding declares it;
 *  - unknown: not established; treated as a write.
 */
export type ContractEffectClass = 'none' | 'human' | 'read' | 'write' | 'irreversible' | 'unknown';

export interface ContractEffect {
  readonly class: ContractEffectClass;
  readonly derivation: 'rules' | 'human_task' | 'binding' | 'undetermined';
  readonly reason: string;
}

export function contractEffectOf(
  contract: SemanticCapabilityContract,
  binding?: { readonly sideEffect: 'read' | 'write' | 'irreversible'; readonly connector?: string; readonly operation?: string },
): ContractEffect {
  if (binding !== undefined)
    return {
      class: binding.sideEffect,
      derivation: 'binding',
      reason: `the workspace binds it to ${binding.connector ?? 'a connector'}${binding.operation !== undefined ? `.${binding.operation}` : ''}, declared ${binding.sideEffect}`,
    };
  if (contract.humanTask !== undefined)
    return { class: 'human', derivation: 'human_task', reason: 'a person performs it (human task contract); XO sends nothing' };
  if (contract.rules.length > 0 && (contract.actionKnowledgeRefs ?? []).length === 0)
    return { class: 'none', derivation: 'rules', reason: 'it evaluates rules and returns a result; nothing outside the run changes' };
  if ((contract.actionKnowledgeRefs ?? []).length > 0)
    return {
      class: 'unknown',
      derivation: 'undetermined',
      reason: 'the source describes an action, but no binding says what it does; treated as a write until one does',
    };
  return { class: 'unknown', derivation: 'undetermined', reason: 'nothing establishes what it does; treated as a write' };
}

/** Fail-closed reading of an effect class: anything that is not provably read-only, rules-only or a person's task may change the world. */
export function mayChangeTheWorld(c: ContractEffectClass): boolean {
  return c === 'write' || c === 'irreversible' || c === 'unknown';
}

export type OutputType = 'string' | 'number' | 'boolean' | 'unknown';

export interface TypedOutputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: OutputType }>>;
  readonly required: readonly string[];
  /** True when every output has a known type; consumers that need a type refuse an untyped output rather than assume one. */
  readonly typed: boolean;
  readonly untyped: readonly string[];
}

/**
 * The capability's outputs as one object schema: the contract's declared outputs (their semantic type, or `unknown`) and, for a
 * human task, its outcome schema. An output named twice keeps the more specific type; two different known types make it
 * `unknown` (a contradiction is not resolved by picking one).
 */
export function contractOutputSchema(contract: SemanticCapabilityContract): TypedOutputSchema {
  const props = new Map<string, OutputType>();
  const required = new Set<string>();
  const add = (name: string, t: OutputType) => {
    const prev = props.get(name);
    props.set(name, prev === undefined || prev === 'unknown' ? t : t === 'unknown' || t === prev ? prev : 'unknown');
  };
  for (const o of contract.outputs) add(o.name, o.semanticType ?? 'unknown');
  const outcome = contract.humanTask?.outcomeSchema;
  if (outcome !== undefined) {
    for (const [name, spec] of Object.entries(outcome.properties)) add(name, spec.type);
    for (const r of outcome.required) required.add(r);
  }
  const names = [...props.keys()].sort();
  const untyped = names.filter((n) => props.get(n) === 'unknown');
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((n) => [n, { type: props.get(n) as OutputType }])),
    required: [...required].sort(),
    typed: untyped.length === 0,
    untyped,
  };
}
