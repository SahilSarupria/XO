import type { EvidenceStrength } from '@xo/xoir';
import type { AuthorityKind } from './authorization.js';
import type { SourceType } from './connector.js';
import { strengthOf, type EpistemicStatus, type ValidationState } from './epistemic.js';
import type { Evidence } from './evidence.js';
import { RelationshipId, stableId, type ConnectorId, type EvidenceId, type SourceId } from './ids.js';
import type { EnvironmentInventory } from './inventory.js';
import { proposeCandidateProcesses, type CandidateProcess } from './process-discovery.js';
import type { SourceAxes, SourceSummaryStatus } from './source-state.js';

/**
 * Where the model's evidence came from. Set by the CALLER and carried into
 * every rendering: a model built from fixtures must say so, and nothing in
 * this package can turn one into the other.
 */
export type ModelOrigin = 'live_discovery' | 'test_fixture';

export interface ResourceRef {
  readonly sourceId: SourceId;
  readonly resourceKey: string;
}

export interface IdentifierTie {
  readonly value: string;
  readonly via: 'filename' | 'content';
  readonly evidence: EvidenceId;
}

export interface ResourceNode {
  readonly ref: ResourceRef;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly contentAcquired: boolean;
  readonly digest?: string;
  readonly identifiers: readonly IdentifierTie[];
  readonly evidenceIds: readonly EvidenceId[];
}

export interface SystemNode {
  readonly sourceId: SourceId;
  readonly sourceType: SourceType;
  readonly displayName: string;
  readonly locator: string;
  readonly status: SourceSummaryStatus;
  readonly axes: SourceAxes;
  readonly connectorId?: ConnectorId;
  /** Distinct authorities behind this system's evidence. Anything other than only `platform` is NOT platform-authorized. */
  readonly evidenceAuthorities: readonly AuthorityKind[];
  readonly evidenceCountByKind: Readonly<Record<string, number>>;
  readonly purgeRequired: boolean;
}

export type RelationshipKind = 'same_content' | 'shares_identifier';

/**
 * An inferred (or directly observed) link between two resources. The
 * fields mirror the evidence-before-inference principle: status with a
 * defined meaning, the evidence ids behind it, honest alternatives, and
 * what is missing. `validation` can only be `not_validated`.
 */
export interface Relationship {
  readonly id: RelationshipId;
  readonly kind: RelationshipKind;
  readonly from: ResourceRef;
  readonly to: ResourceRef;
  readonly identifier?: string;
  readonly status: EpistemicStatus;
  readonly strength: EvidenceStrength;
  readonly validation: ValidationState;
  /** Kinds of evidence that independently tie BOTH endpoints (see CORROBORATION_RULE). */
  readonly supportingKinds: readonly string[];
  readonly evidence: readonly EvidenceId[];
  readonly statement: string;
  readonly alternativeExplanations: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly humanReviewRequired: true;
}

export interface Unknown {
  readonly question: string;
  readonly reason: string;
  readonly about?: ResourceRef | { readonly sourceId: SourceId };
}

export interface EnvironmentModel {
  readonly schemaVersion: 'ei.environment-model/v0';
  readonly origin: ModelOrigin;
  readonly generatedAt: string;
  readonly systems: readonly SystemNode[];
  readonly resources: readonly ResourceNode[];
  readonly relationships: readonly Relationship[];
  readonly processes: readonly CandidateProcess[];
  readonly unknowns: readonly Unknown[];
  readonly evidenceCount: number;
  /**
   * Intentionally empty in this milestone. This model is NOT XOIR and does
   * not write to it; a reviewed projection of selected, validated claims
   * into XOIR is a proposal (docs/environment-intelligence/ARCHITECTURE.md).
   */
  readonly xoirLinks: readonly never[];
  readonly notices: readonly string[];
}

export interface BuildModelInput {
  readonly origin: ModelOrigin;
  readonly generatedAt: string;
  readonly inventory: EnvironmentInventory;
  readonly evidence: readonly Evidence[];
}

const refKey = (r: ResourceRef): string => `${r.sourceId}/${r.resourceKey}`;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Builds the model from inventory + evidence. Pure and deterministic: same inputs, byte-identical output. */
export function buildEnvironmentModel(input: BuildModelInput): EnvironmentModel {
  // Repeat discovery yields identical evidence ids; keep one of each.
  const unique = new Map<EvidenceId, Evidence>();
  for (const e of input.evidence) if (!unique.has(e.id)) unique.set(e.id, e);
  const evidence = [...unique.values()].sort((a, b) => cmp(a.id, b.id));

  const resources = new Map<string, { node: ResourceNode; ties: IdentifierTie[]; evidenceIds: EvidenceId[] }>();
  const ensure = (ref: ResourceRef, e: Evidence): { node: ResourceNode; ties: IdentifierTie[]; evidenceIds: EvidenceId[] } => {
    const k = refKey(ref);
    let entry = resources.get(k);
    if (entry === undefined) {
      const name = ref.resourceKey.split('/').pop() ?? ref.resourceKey;
      entry = {
        node: { ref, name, extension: '', sizeBytes: 0, modifiedAt: '', contentAcquired: false, identifiers: [], evidenceIds: [] },
        ties: [],
        evidenceIds: [],
      };
      resources.set(k, entry);
    }
    entry.evidenceIds.push(e.id);
    return entry;
  };

  for (const e of evidence) {
    if (e.resourceKey === '') continue;
    const ref: ResourceRef = { sourceId: e.sourceId, resourceKey: e.resourceKey };
    if (e.kind === 'resource_inventory') {
      const entry = ensure(ref, e);
      entry.node = {
        ...entry.node,
        name: str(e.payload['name'], entry.node.name),
        extension: str(e.payload['extension']),
        sizeBytes: num(e.payload['sizeBytes']),
        modifiedAt: str(e.payload['modifiedAt']),
      };
      const nameTokens = str(e.payload['name']).match(/\b[A-Z]{2,5}-\d{3,8}\b/g) ?? [];
      for (const t of new Set(nameTokens)) entry.ties.push({ value: t, via: 'filename', evidence: e.id });
    } else if (e.kind === 'document_content') {
      const entry = ensure(ref, e);
      const covers = e.payload['digestCoversWholeFile'] === true;
      entry.node = { ...entry.node, contentAcquired: true, ...(covers ? { digest: str(e.payload['digest']) } : {}) };
      const ids = e.payload['identifiers'];
      if (Array.isArray(ids)) for (const t of ids) if (typeof t === 'string') entry.ties.push({ value: t, via: 'content', evidence: e.id });
    }
  }

  const nodes: ResourceNode[] = [...resources.values()]
    .map(({ node, ties, evidenceIds }) => ({
      ...node,
      identifiers: [...ties].sort((a, b) => cmp(a.value + a.via, b.value + b.via)),
      evidenceIds: [...new Set(evidenceIds)].sort(cmp) as EvidenceId[],
    }))
    .sort((a, b) => cmp(refKey(a.ref), refKey(b.ref)));

  const relationships: Relationship[] = [];

  // 1. Identical content: directly observed (equal digests over whole files).
  const byDigest = new Map<string, ResourceNode[]>();
  for (const n of nodes) if (n.digest !== undefined && n.digest !== '') byDigest.set(n.digest, [...(byDigest.get(n.digest) ?? []), n]);
  for (const digest of [...byDigest.keys()].sort()) {
    const group = byDigest.get(digest) ?? [];
    const anchor = group[0];
    if (anchor === undefined) continue;
    for (const other of group.slice(1)) {
      const evidenceIds = [...new Set([...anchor.evidenceIds, ...other.evidenceIds])].sort(cmp) as EvidenceId[];
      relationships.push({
        id: RelationshipId(stableId('rel', ['same_content', digest, refKey(anchor.ref), refKey(other.ref)])),
        kind: 'same_content',
        from: anchor.ref,
        to: other.ref,
        status: 'directly_observed',
        strength: strengthOf('directly_observed'),
        validation: 'not_validated',
        supportingKinds: ['content_digest'],
        evidence: evidenceIds,
        statement: `The two files have byte-identical content (same SHA-256 over the whole file).`,
        alternativeExplanations: [],
        missingEvidence: ['Identical bytes do not show whether one is a deliberate copy of the other or why both exist.'],
        humanReviewRequired: true,
      });
    }
  }

  // 2. Shared business identifier: an inference, status depends on independent kinds of evidence.
  const byIdentifier = new Map<string, ResourceNode[]>();
  for (const n of nodes)
    for (const v of new Set(n.identifiers.map((t) => t.value))) byIdentifier.set(v, [...(byIdentifier.get(v) ?? []), n]);
  for (const identifier of [...byIdentifier.keys()].sort()) {
    const group = byIdentifier.get(identifier) ?? [];
    // Every pair is judged independently against the corroboration rule.
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const anchor = group[i];
        const other = group[j];
        if (anchor === undefined || other === undefined) continue;
        const viaOf = (n: ResourceNode): Set<string> => new Set(n.identifiers.filter((t) => t.value === identifier).map((t) => t.via));
        const a = viaOf(anchor);
        const b = viaOf(other);
        const both = [...a].filter((k) => b.has(k)).sort();
        const corroborated = both.length >= 2;
        const status: EpistemicStatus = corroborated ? 'corroborated_inference' : 'candidate_hypothesis';
        const evidenceIds = [
          ...new Set([anchor, other].flatMap((n) => n.identifiers.filter((t) => t.value === identifier).map((t) => t.evidence))),
        ].sort(cmp) as EvidenceId[];
        relationships.push({
          id: RelationshipId(stableId('rel', ['shares_identifier', identifier, refKey(anchor.ref), refKey(other.ref)])),
          kind: 'shares_identifier',
          from: anchor.ref,
          to: other.ref,
          identifier,
          status,
          strength: strengthOf(status),
          validation: 'not_validated',
          supportingKinds: both,
          evidence: evidenceIds,
          statement: corroborated
            ? `Both files carry the identifier ${identifier} in more than one independent way (${both.join(' and ')}).`
            : `Both files carry the identifier ${identifier}, but only through ${both.length === 1 ? `their ${both[0]}` : 'different kinds of evidence'}.`,
          alternativeExplanations: [
            'Identifier-shaped tokens can coincide (reused numbering schemes, templates, example text).',
            'Sharing an identifier does not show that the files describe the same transaction or that one depends on the other.',
          ],
          missingEvidence: [
            ...(corroborated
              ? []
              : [
                  'A second, independent kind of evidence (for example the file content, if only the name was seen) has not corroborated the link.',
                ]),
            'No record from a system of record confirms the link.',
          ],
          humanReviewRequired: true,
        });
      }
  }

  // Systems.
  const systems: SystemNode[] = input.inventory.list().map((rec) => {
    const mine = evidence.filter((e) => e.sourceId === rec.source.sourceId);
    const counts: Record<string, number> = {};
    for (const e of mine) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const authorities = [...new Set(mine.map((e) => e.provenance.access.authority))].sort() as AuthorityKind[];
    return {
      sourceId: rec.source.sourceId,
      sourceType: rec.source.sourceType,
      displayName: rec.source.displayName,
      locator: rec.source.locator,
      status: rec.status,
      axes: rec.axes,
      ...(rec.connectorId !== undefined ? { connectorId: rec.connectorId } : {}),
      evidenceAuthorities: authorities,
      evidenceCountByKind: Object.fromEntries(Object.entries(counts).sort(([x], [y]) => cmp(x, y))),
      purgeRequired: rec.purgeRequired,
    };
  });

  // Unknowns: stated, never silently dropped.
  const unknowns: Unknown[] = [];
  for (const s of systems) {
    if (s.status !== 'acquisition_successful') {
      unknowns.push({
        question: `What does ${s.displayName} contain?`,
        reason: `Source is "${s.status}"; it was not fully inspected.`,
        about: { sourceId: s.sourceId },
      });
    }
    if (s.sourceType === 'local_filesystem') {
      unknowns.push({
        question: 'Which applications, accounts or remote services does the organization use?',
        reason: 'A directory scan cannot reveal them; other discovery sources would be needed.',
        about: { sourceId: s.sourceId },
      });
    }
  }
  for (const n of nodes) {
    if (!n.contentAcquired && n.identifiers.length > 0) {
      unknowns.push({
        question: `Does ${n.name} actually contain the identifier(s) its name suggests?`,
        reason: 'Only the file name was observed; content was not acquired or not permitted.',
        about: n.ref,
      });
    }
  }

  const processes = proposeCandidateProcesses(nodes);
  const notices = [
    input.origin === 'test_fixture'
      ? 'TEST FIXTURE: this model was built from fixture data and is not a customer environment.'
      : 'Built from live discovery of the authorized scope only; not validated organizational knowledge.',
    'All relationships and processes are unvalidated and require human review. Nothing here grants permission or is executable.',
    ...(systems.some((s) => s.evidenceAuthorities.includes('development_unverified'))
      ? ['Some evidence was read under a DEVELOPMENT-ONLY operator allow-list, not the platform authorization gate.']
      : []),
  ];

  return Object.freeze({
    schemaVersion: 'ei.environment-model/v0',
    origin: input.origin,
    generatedAt: input.generatedAt,
    systems,
    resources: nodes,
    relationships: relationships.sort((a, b) => cmp(a.id, b.id)),
    processes,
    unknowns,
    evidenceCount: evidence.length,
    xoirLinks: [],
    notices,
  });
}
