import { fromJson, type XoirGraphJson } from '@xo/xoir';
import { validateCapabilityInput } from '@xo/capability-contract';
import { findInputSchema, rebuildContractAndBinding } from './execute-capability.js';

/**
 * Validate / Preview: everything a Test Run would check BEFORE it invokes anything, and nothing after.
 *
 * It rebuilds the contract and resolves the binding from the stored compiled graph (the same two calls the real
 * execution path makes first), validates the supplied input against the capability's declared input schema, and
 * describes — from the binding's own declared class — what a real run would do. It never calls the binding's
 * `evaluate`, never registers or executes anything, never writes an execution record, and never touches a human
 * task. A preview can therefore run on a capability that is NOT approved; that is its purpose.
 *
 * What a preview does not and cannot tell you: that the real run will succeed. It is a pre-flight, not a
 * simulation of results, and `previewOnly: true` says so in the response so a UI cannot mistake it for one.
 */

export interface PreviewIssue {
  readonly path: string;
  readonly message: string;
}

export type CapabilityPreview =
  | {
      readonly kind: 'ready';
      readonly contract: {
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly inputs: readonly {
          readonly name: string;
          readonly type?: string;
          readonly required?: boolean;
          readonly description?: string;
        }[];
        readonly outputs: readonly { readonly name: string; readonly type?: string; readonly description?: string }[];
        readonly requiredPermissions: readonly string[];
        readonly ruleCount: number;
        readonly actionReferenceCount: number;
        readonly confidence: number;
        readonly determinism: string;
      };
      readonly binding: {
        readonly id: string;
        readonly implementationClass: string;
        readonly resolverName: string;
        readonly description: string;
      };
      readonly inputSchemaDeclared: boolean;
      readonly inputIssues: readonly PreviewIssue[];
      readonly plan: readonly string[];
      /** What running it for real would do to the outside world, stated from the binding class. `none` means the runtime itself performs no external effect. */
      readonly externalEffects: 'none' | 'creates_human_task';
    }
  | { readonly kind: 'unresolved'; readonly status: 'unresolved' | 'ambiguous' | 'denied'; readonly reason: string }
  | { readonly kind: 'error'; readonly errorCode: string; readonly errorMessage: string };

export function previewCapability(compiledGraphJson: unknown, capabilityId: string, input: unknown): CapabilityPreview {
  const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graphResult.ok) return { kind: 'error', errorCode: graphResult.error.code, errorMessage: graphResult.error.message };
  const rebuilt = rebuildContractAndBinding(compiledGraphJson, capabilityId);
  if (!rebuilt.ok) {
    const o = rebuilt.outcome;
    if (o.kind === 'unresolved') return { kind: 'unresolved', status: o.status, reason: o.reason };
    if (o.kind === 'error') return { kind: 'error', errorCode: o.errorCode, errorMessage: o.errorMessage };
    return { kind: 'error', errorCode: 'UNEXPECTED', errorMessage: 'the contract could not be rebuilt' };
  }
  const { contract, binding } = rebuilt.value;

  const schema = findInputSchema(graphResult.value, contract.id);
  const validation = schema !== undefined ? validateCapabilityInput(schema, input) : undefined;
  const inputIssues: PreviewIssue[] =
    validation !== undefined && !validation.valid ? validation.issues.map((i) => ({ path: i.property, message: i.message })) : [];

  const escalates = binding.implementationClass === 'human_in_the_loop';
  const plan = [
    'Check the compilation succeeded and the capability is approved (a real run is refused otherwise).',
    `Resolve the contract to a "${binding.implementationClass}" binding (${binding.resolverName}).`,
    schema !== undefined
      ? 'Validate the input against the declared input schema.'
      : 'No input schema is declared, so the input is not validated.',
    escalates
      ? 'Produce an escalation record and open a human task; the runtime never performs the underlying real-world action.'
      : 'Evaluate the deterministic rules over the input and return the result; no external system is called.',
  ];

  return {
    kind: 'ready',
    contract: {
      id: contract.id,
      name: contract.name,
      description: contract.description,
      inputs: contract.inputs.map((p) => ({ ...p })) as never,
      outputs: contract.outputs.map((p) => ({ ...p })) as never,
      requiredPermissions: contract.requiredPermissions,
      ruleCount: contract.rules.length,
      actionReferenceCount: contract.actionKnowledgeRefs.length,
      confidence: contract.confidence,
      determinism: String(contract.determinism),
    },
    binding: {
      id: binding.id,
      implementationClass: binding.implementationClass,
      resolverName: binding.resolverName,
      description: binding.description,
    },
    inputSchemaDeclared: schema !== undefined,
    inputIssues,
    plan,
    externalEffects: escalates ? 'creates_human_task' : 'none',
  };
}
