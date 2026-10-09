import type { XoirGraph, XoirNode } from '@xo/xoir';
import { XoirNodeId } from '@xo/xoir';
import {
  buildSemanticCapabilityContract,
  extractContractFromPropertyBag,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import type {
  CandidateWorkflow,
  StepDataBinding,
  StepDataBindingStatus,
  WorkflowDataFlowReport,
} from './types.js';

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to']);

function normalizeParamKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ');
}

function isTypeCompatible(typeA?: string, typeB?: string): boolean {
  if (!typeA || !typeB || typeA === 'unknown' || typeB === 'unknown') {
    return true;
  }
  return typeA === typeB;
}

interface StepContractEntry {
  readonly step: CandidateWorkflow['steps'][number];
  readonly index: number;
  readonly contract?: SemanticCapabilityContract | undefined;
}

export function auditWorkflowDataFlow(
  workflow: CandidateWorkflow,
  graph: XoirGraph,
): WorkflowDataFlowReport {
  // 1. Retrieve contracts for each step in order
  const stepEntries: StepContractEntry[] = workflow.steps.map((step, index) => {
    const nodeRes = graph.getNode(XoirNodeId(step.capabilityId));
    let contract: SemanticCapabilityContract | undefined;
    if (nodeRes.ok) {
      const node: XoirNode = nodeRes.value;
      const extracted = extractContractFromPropertyBag(node.properties);
      if (extracted.ok) {
        contract = extracted.value;
      } else {
        const built = buildSemanticCapabilityContract(graph, XoirNodeId(step.capabilityId));
        if (built.ok) {
          contract = built.value;
        }
      }
    }
    return { step, index, contract };
  });

  // 2. Discover graph-level structural links between capability nodes
  const directStructuralEdges = new Set<string>();
  const conceptProducerMap = new Map<string, string[]>(); // conceptId -> capIds
  const conceptConsumerMap = new Map<string, string[]>(); // conceptId -> capIds

  for (const edge of graph.allEdges()) {
    const fromId = edge.fromId as string;
    const toId = edge.toId as string;
    const kind = edge.kind;

    if (kind === 'PRODUCES') {
      const list = conceptProducerMap.get(toId) ?? [];
      list.push(fromId);
      conceptProducerMap.set(toId, list);
    } else if (kind === 'CONSUMES') {
      const list = conceptConsumerMap.get(toId) ?? [];
      list.push(fromId);
      conceptConsumerMap.set(toId, list);
    }

    if (kind !== 'COMPLEMENTS' && kind !== 'custom:sequence') {
      directStructuralEdges.add(`${fromId}:${toId}`);
      directStructuralEdges.add(`${toId}:${fromId}`);
    }
  }

  const conceptHandoffPairs = new Set<string>();
  for (const [conceptId, producers] of conceptProducerMap.entries()) {
    const consumers = conceptConsumerMap.get(conceptId) ?? [];
    for (const p of producers) {
      for (const c of consumers) {
        conceptHandoffPairs.add(`${p}:${c}`);
      }
    }
  }

  const bindings: StepDataBinding[] = [];
  const unboundInputs: {
    readonly stepId: CandidateWorkflow['steps'][number]['id'];
    readonly capabilityId: string;
    readonly parameterName: string;
    readonly derivedFrom: 'declared' | 'rule_derived' | 'unknown';
  }[] = [];

  // 3. Process each consumer step and its required inputs
  for (let cIdx = 0; cIdx < stepEntries.length; cIdx++) {
    const consumerEntry = stepEntries[cIdx]!;
    const consumerStep = consumerEntry.step;
    const consumerContract = consumerEntry.contract;

    if (!consumerContract || consumerContract.inputs.length === 0) {
      continue;
    }

    for (const inputParam of consumerContract.inputs) {
      const inputName = inputParam.name;
      const inputNormKey = normalizeParamKey(inputName);
      const inputSemType = inputParam.semanticType;
      const derivedFromRaw = inputParam.derivedFrom;
      const derivedFrom: 'declared' | 'rule_derived' | 'unknown' =
        derivedFromRaw === 'declared'
          ? 'declared'
          : derivedFromRaw === 'rule_derived'
            ? 'rule_derived'
            : 'unknown';

      if (!inputNormKey) continue;

      let bestProvenBinding: StepDataBinding | undefined;
      let bestSuggestiveBinding: StepDataBinding | undefined;

      // Look back at preceding steps (producerStep comes strictly before consumerStep)
      for (let pIdx = 0; pIdx < cIdx; pIdx++) {
        const producerEntry = stepEntries[pIdx]!;
        const producerStep = producerEntry.step;
        const producerContract = producerEntry.contract;

        if (!producerContract || producerContract.outputs.length === 0) {
          continue;
        }

        for (const outputParam of producerContract.outputs) {
          const outputName = outputParam.name;
          const outputNormKey = normalizeParamKey(outputName);
          const outputSemType = outputParam.semanticType;

          if (outputNormKey !== inputNormKey) {
            continue;
          }

          // Check primitive type compatibility
          const typeMatch = isTypeCompatible(outputSemType, inputSemType);
          if (!typeMatch) {
            // Type conflict (e.g. number vs string) prevents binding
            continue;
          }

          // Check structural corroboration
          const pairKey = `${producerStep.capabilityId}:${consumerStep.capabilityId}`;
          const hasConceptHandoff = conceptHandoffPairs.has(pairKey);
          const hasDirectEdge = directStructuralEdges.has(pairKey);
          const hasStructuralCorroboration = hasConceptHandoff || hasDirectEdge;

          if (hasStructuralCorroboration) {
            bestProvenBinding = {
              producerStepId: producerStep.id,
              producerCapabilityId: producerStep.capabilityId,
              outputParameterName: outputName,
              consumerStepId: consumerStep.id,
              consumerCapabilityId: consumerStep.capabilityId,
              inputParameterName: inputName,
              status: 'proven',
              evidenceKind: 'explicit_contract_match',
              rationale: `Proven binding: explicit output "${outputName}" on step "${producerStep.capabilityId}" matches input "${inputName}" on step "${consumerStep.capabilityId}" with structural graph corroboration.`,
            };
            break; // Stop searching for this producer once proven
          } else {
            if (!bestSuggestiveBinding) {
              bestSuggestiveBinding = {
                producerStepId: producerStep.id,
                producerCapabilityId: producerStep.capabilityId,
                outputParameterName: outputName,
                consumerStepId: consumerStep.id,
                consumerCapabilityId: consumerStep.capabilityId,
                inputParameterName: inputName,
                status: 'suggestive',
                evidenceKind: 'name_similarity_only',
                rationale: `Suggestive binding: parameter name "${inputName}" matches output on step "${producerStep.capabilityId}", but lacks structural graph edge corroboration.`,
              };
            }
          }
        }

        if (bestProvenBinding) break;
      }

      // Check concept-level PRODUCES/CONSUMES handoff without field match as a suggestive fallback
      if (!bestProvenBinding && !bestSuggestiveBinding) {
        for (let pIdx = 0; pIdx < cIdx; pIdx++) {
          const producerEntry = stepEntries[pIdx]!;
          const producerStep = producerEntry.step;
          const pairKey = `${producerStep.capabilityId}:${consumerStep.capabilityId}`;
          if (conceptHandoffPairs.has(pairKey)) {
            bestSuggestiveBinding = {
              producerStepId: producerStep.id,
              producerCapabilityId: producerStep.capabilityId,
              outputParameterName: '',
              consumerStepId: consumerStep.id,
              consumerCapabilityId: consumerStep.capabilityId,
              inputParameterName: inputName,
              status: 'suggestive',
              evidenceKind: 'concept_produces_consumes',
              rationale: `Suggestive binding: step "${producerStep.capabilityId}" produces a concept consumed by step "${consumerStep.capabilityId}", but lacks a field-level parameter match for "${inputName}".`,
            };
            break;
          }
        }
      }

      if (bestProvenBinding) {
        bindings.push(bestProvenBinding);
      } else if (bestSuggestiveBinding) {
        bindings.push(bestSuggestiveBinding);
        // A suggestive binding does not satisfy the input provenly, so the input remains unbound in terms of proven execution.
        unboundInputs.push({
          stepId: consumerStep.id,
          capabilityId: consumerStep.capabilityId,
          parameterName: inputName,
          derivedFrom,
        });
      } else {
        unboundInputs.push({
          stepId: consumerStep.id,
          capabilityId: consumerStep.capabilityId,
          parameterName: inputName,
          derivedFrom,
        });
      }
    }
  }

  // Sort bindings and unboundInputs deterministically by stepId & parameterName
  bindings.sort((a, b) => {
    if (a.consumerStepId !== b.consumerStepId) {
      return a.consumerStepId < b.consumerStepId ? -1 : 1;
    }
    return a.inputParameterName < b.inputParameterName ? -1 : a.inputParameterName > b.inputParameterName ? 1 : 0;
  });

  unboundInputs.sort((a, b) => {
    if (a.stepId !== b.stepId) {
      return a.stepId < b.stepId ? -1 : 1;
    }
    return a.parameterName < b.parameterName ? -1 : a.parameterName > b.parameterName ? 1 : 0;
  });

  return {
    bindings,
    unboundInputs,
  };
}
