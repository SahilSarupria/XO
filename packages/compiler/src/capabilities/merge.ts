import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateCapability, CapabilityExtractionResult } from './extractor-types.js';
import { computeCapabilityId, computeCapabilityMatchKey } from './capability-id.js';
import type { Capability, CapabilityId, CapabilitySignature } from './types.js';
import { UNKNOWN_SIGNATURE } from './types.js';

export interface PerUnitCapabilityExtraction {
  readonly unit: ExperienceUnit;
  readonly extraction: CapabilityExtractionResult;
}

export interface CapabilityMergeResult {
  readonly capabilities: readonly Capability[];
  readonly resolveLocalId: (sourceUnitId: string, localId: string) => CapabilityId | undefined;
}

function localIdKey(sourceUnitId: string, localId: string): string {
  return `${sourceUnitId}\u0000${localId}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Prefers the first non-`'unknown'` value found (stable, deterministic order) — a future extractor that actually knows a capability's determinism/idempotency/cost should win over one that honestly doesn't. */
function firstKnown<T extends string | boolean>(values: readonly (T | 'unknown')[], fallback: T | 'unknown'): T | 'unknown' {
  for (const v of values) {
    if (v !== 'unknown') return v;
  }
  return fallback;
}

function mergeSignatures(signatures: readonly CapabilitySignature[]): CapabilitySignature {
  if (signatures.length === 0) return UNKNOWN_SIGNATURE;
  return {
    inputs: dedupeInputsOutputs(signatures.flatMap((s) => s.inputs)),
    outputs: dedupeInputsOutputs(signatures.flatMap((s) => s.outputs)),
    sideEffects: dedupeStrings(signatures.flatMap((s) => s.sideEffects)),
    requiredResources: dedupeStrings(signatures.flatMap((s) => s.requiredResources)),
    determinism: firstKnown(signatures.map((s) => s.determinism), 'unknown'),
    idempotent: firstKnown(signatures.map((s) => s.idempotent), 'unknown'),
    executionMode: firstKnown(signatures.map((s) => s.executionMode), 'unknown'),
    estimatedCost: firstKnown(signatures.map((s) => s.estimatedCost), 'unknown'),
  };
}

function dedupeInputsOutputs(params: readonly { readonly name: string; readonly description: string }[]): readonly { readonly name: string; readonly description: string }[] {
  const seen = new Set<string>();
  const result: { readonly name: string; readonly description: string }[] = [];
  for (const p of params) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    result.push(p);
  }
  return result;
}

/**
 * Groups every candidate capability — from every unit, from every
 * extractor that ran — by its match key (category + word-set-normalized
 * name, see `capability-id.ts`) and merges each group into one final
 * `Capability`: "Send Email", "Email Sending", and "Mail Sender" all land
 * in the same group and become one capability. Mirrors
 * `../knowledge/merge.ts#mergeKnowledgeNodes` exactly in approach —
 * canonical name by frequency (ties broken by first-seen), aliases from
 * every other distinct surface form, confidence averaged, provenance and
 * knowledge-node/concept references unioned, signature merged
 * field-by-field preferring known values over `'unknown'`.
 *
 * `dependencies` is left empty here — populated afterward by
 * `relationship-builder.ts`, once `depends_on` edges exist to derive it
 * from, the same two-phase split Stage 3 used for `documentReferences`.
 */
export function mergeCapabilities(perUnit: readonly PerUnitCapabilityExtraction[]): CapabilityMergeResult {
  const allCandidates: CandidateCapability[] = [];
  for (const { extraction } of perUnit) allCandidates.push(...extraction.capabilities);

  const groups = new Map<string, CandidateCapability[]>();
  for (const candidate of allCandidates) {
    const key = computeCapabilityMatchKey(candidate.category, candidate.name);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }

  const capabilities: Capability[] = [];
  const localIdMap = new Map<string, CapabilityId>();

  for (const candidates of groups.values()) {
    const category = candidates[0]!.category;

    const nameCounts = new Map<string, number>();
    for (const c of candidates) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
    let canonicalName = candidates[0]!.name;
    let bestCount = 0;
    for (const c of candidates) {
      const count = nameCounts.get(c.name)!;
      if (count > bestCount) {
        bestCount = count;
        canonicalName = c.name;
      }
    }

    const aliases = [...new Set(candidates.map((c) => c.name))].filter((n) => n !== canonicalName).sort();
    const confidence = round3(candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length);
    const provenance = candidates.map((c) => c.provenance);
    const description = candidates.map((c) => c.description).find((d) => d.length > 0) ?? '';
    const inputs = dedupeStrings(candidates.flatMap((c) => c.inputs));
    const outputs = dedupeStrings(candidates.flatMap((c) => c.outputs));
    const requiredKnowledgeNodeIds = dedupeStrings(candidates.flatMap((c) => c.requiredKnowledgeNodeIds)) as readonly Capability['requiredKnowledgeNodeIds'][number][];
    const relatedConcepts = dedupeStrings(candidates.flatMap((c) => c.relatedConcepts));
    const invocationHints = dedupeStrings(candidates.flatMap((c) => c.invocationHints));
    const examples = dedupeStrings(candidates.flatMap((c) => c.examples));
    const signature = mergeSignatures(candidates.map((c) => c.signature));
    const metadata: Record<string, string> = {};
    for (const c of candidates) Object.assign(metadata, c.metadata);

    // P0.9A area B: union `inputTypes` across every candidate in this
    // group, but only keep a key when every candidate that declares it
    // agrees on the value — a genuine conflict (two structured sources
    // disagreeing on a param's type) is dropped rather than resolved by
    // last-writer-wins, since silently picking one would be exactly the
    // kind of fabrication this milestone's scope explicitly forbids.
    const inputTypesByKey = new Map<string, Set<string>>();
    for (const c of candidates) {
      if (!c.inputTypes) continue;
      for (const [key, value] of Object.entries(c.inputTypes)) {
        if (!inputTypesByKey.has(key)) inputTypesByKey.set(key, new Set());
        inputTypesByKey.get(key)!.add(value);
      }
    }
    const inputTypeEntries = [...inputTypesByKey.entries()].filter(([, values]) => values.size === 1).map(([key, values]) => [key, [...values][0]!] as const);
    const inputTypes = inputTypeEntries.length > 0 ? Object.fromEntries(inputTypeEntries) : undefined;

    const id = computeCapabilityId(category, canonicalName);
    const extractorNames = new Set(candidates.map((c) => c.extractorName).filter((n): n is string => n !== undefined));
    const producedBy = extractorNames.size === 1 ? [...extractorNames][0] : undefined;
    capabilities.push({
      id,
      canonicalName,
      aliases,
      description,
      category,
      confidence,
      provenance,
      inputs,
      outputs,
      dependencies: [],
      requiredKnowledgeNodeIds,
      relatedConcepts,
      requiredPermissions: [],
      invocationHints,
      examples,
      signature,
      metadata,
      ...(producedBy !== undefined ? { producedBy } : {}),
      ...(inputTypes !== undefined ? { inputTypes } : {}),
    });

    for (const c of candidates) {
      localIdMap.set(localIdKey(c.sourceUnitId, c.localId), id);
    }
  }

  capabilities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    capabilities,
    resolveLocalId: (sourceUnitId, localId) => localIdMap.get(localIdKey(sourceUnitId, localId)),
  };
}
