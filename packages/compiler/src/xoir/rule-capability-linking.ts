import { XoirEdgeId, XoirNodeId, confidenceFromScore, type XoirGraph, type XoirPropertyBag } from '@xo/xoir';
import { isStrictSectionPathPrefix, scoreLink, scoreStructuralLink, significantTokens, type LinkCandidate, type StructuralLinkCandidate } from './semantic-link.js';

/**
 * Shared implementation behind both Stage 7's rule -> capability/concept
 * linking (`reasoning-to-xoir.ts`'s `decision_node`/`heuristic`/
 * `prerequisite`/... nodes) and Stage 4's rule -> capability/concept
 * linking (`knowledge-to-xoir.ts`'s `constraint`/`obligation`/`exception`
 * nodes — see `knowledge-to-xoir.ts#collectKnowledgeRuleSources`).
 *
 * Extracted out of `reasoning-to-xoir.ts` (where this logic originally
 * lived, scoped only to `ReasoningGraph` nodes) rather than duplicated,
 * because the association question — "does this rule node's text
 * evidence-backedly reference this capability/concept node" — is
 * identical regardless of which compiler stage produced the rule node.
 * `@xo/capability-contract`'s `contract-builder.ts` already treats
 * `constraint` exactly like `decision_node`/`heuristic` when projecting a
 * `SemanticCapabilityContract` (see its `RULE_KINDS`), so a Stage-4
 * `constraint` node reachable this way is just as usable a rule as a
 * Stage-7 one — the gap was never in the *consumer*, only in the
 * *producer* only ever offering Stage 7 nodes as candidates.
 *
 * Reuses `semantic-link.ts#scoreLink`'s two-tier evidence model verbatim
 * (see that module's own doc comment) — no new, weaker evidence tier is
 * introduced here. Never invents a link when neither tier's evidence
 * exists.
 *
 * For a `capability` candidate, the same-unit-term-overlap tier is given
 * `name` PLUS `description` as its vocabulary pool (`scoreLink`'s
 * `LinkCandidate.sameUnitText` — see that field's own doc comment), while
 * `exact_label` matching still only ever checks the bare `name`. A
 * capability's `description` is its full originating sentence (rule-kind
 * capabilities) or a content excerpt (title-derived capabilities) — see
 * `@xo/compiler`'s `capabilities/rule-based-extractor.ts` — and is
 * frequently the only place a generic, verb-derived `name` (e.g.
 * `"Review Action"`, `"Schedule Action"`) actually carries any of the
 * capability's real domain vocabulary. `concept` candidates are
 * unaffected: their only text (`definition`) already is `label`.
 *
 * Problem B.1 — before scoring, this module computes a candidate-pool
 * term-document-frequency map from `referenceable`'s own texts (see
 * `buildCandidateTermFrequency`) and passes it into every `scoreLink`
 * call, so a single shared token that several different candidates all
 * happen to contain (a real, observed failure mode — see that
 * function's doc comment) is not treated as sufficient evidence on its
 * own.
 */

const MIN_REFERENCE_LABEL_LENGTH = 4;
const REFERENCEABLE_KINDS = new Set(['capability', 'concept']);

/**
 * Metadata key marking a `capability` node as minted by M1.1's
 * `../capabilities/rule-capability-minter.ts` — one dedicated capability
 * per already-cleanly-executable decision rule, distinct from the
 * coarse, section/verb-scoped capabilities `rule-based-extractor.ts`
 * produces. See that module's doc comment for the full rationale.
 *
 * These minted capabilities are deliberately EXCLUDED from the generic
 * same-unit-term-overlap `referenceable` pool below (see
 * `linkRuleSourcesToReferencedNodes`'s filter) rather than left to
 * compete in it: a minted capability's description is drawn directly
 * from its one originating rule's own condition/outcome text, so it
 * shares generic same-unit vocabulary (e.g. "claim", "amount") with
 * every *other* rule in the same document section just as strongly as
 * with its own rule — `scoreLink`'s same-unit tier fires on a single
 * shared significant token, so without this exclusion a minted
 * capability would reliably attract unrelated, unsupported sibling
 * rules (exceptions, temporal conditions, prerequisites) too,
 * recreating the exact all-or-nothing contamination minting exists to
 * avoid. Each minted capability instead gets exactly one, deterministic
 * edge back to its own rule via `linkMintedRuleCapabilities` below.
 */
export const RULE_DERIVED_METADATA_KEY = 'xoRuleDerived';
/** Metadata key carrying the originating rule node's id on a minted capability — see {@link RULE_DERIVED_METADATA_KEY}. */
export const RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY = 'xoRuleDerivedSourceNodeId';


/** One candidate rule-node source of content-mention linking: the node's own id, the text to score against every referenceable capability/concept label, and the `experienceUnitId` of its first source reference (for the same-unit-term-overlap tier — see `semantic-link.ts`). */
export interface RuleLinkSource {
  readonly nodeId: string;
  readonly searchableText: string;
  readonly unitId: string | undefined;
}

/**
 * Problem B.1 — document frequency of every significant token across
 * `referenceable`'s own candidate texts (the exact same
 * `sameUnitText ?? label` pool `scoreLink` matches against), counted
 * once per distinct candidate (a term repeated within one candidate's
 * text still counts once for that candidate — `significantTokens`
 * already returns a `Set`). This is the smallest population that
 * corresponds to what a single shared token is actually being asked to
 * discriminate between: not the whole document, not the rule-source
 * side, just the candidates a rule could conceivably link to in this
 * call. Computed once per `linkRuleSourcesToReferencedNodes` invocation
 * from data already assembled for `referenceable` itself — no new
 * traversal, no global or cross-compilation state, no persisted index.
 * See `scoreLink`'s own doc comment for how this is used.
 */
function buildCandidateTermFrequency(referenceable: readonly { readonly candidate: LinkCandidate }[]): ReadonlyMap<string, number> {
  const frequency = new Map<string, number>();
  for (const { candidate } of referenceable) {
    const text = (candidate.sameUnitText ?? candidate.label).trim();
    if (text.length === 0) continue;
    for (const term of significantTokens(text)) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  return frequency;
}

/**
 * Problem C — one entry per non-minted `capability` node in `target`
 * eligible to structurally govern a reasoning node (i.e. excluding
 * root-level ones — see `StructuralLinkCandidate`'s doc comment; the
 * root check is applied here, once, rather than re-derived per call, so
 * a root-level capability never even enters the candidate pool this
 * module searches). Deliberately CAPABILITY nodes only, never `concept`
 * — Problem C's own scope is "reasoning node -> governing capability
 * section," not general same-unit referenceability, and a concept has
 * no meaningful "descendant subtree" the way a document section does.
 * Reuses the exact same minted-capability exclusion as `referenceable`
 * below, for the identical reason: a minted capability already has its
 * own dedicated, structurally-derived edge via
 * `linkMintedRuleCapabilities` and must not additionally compete for
 * unrelated sibling content the way a broad structural-containment
 * search could otherwise expose it to.
 */
function buildStructuralCapabilityCandidates(target: XoirGraph): readonly { readonly id: ReturnType<typeof XoirNodeId>; readonly candidate: StructuralLinkCandidate }[] {
  return target
    .allNodes()
    .filter((n) => n.kind === 'capability')
    .filter((n) => {
      const metadata = (n.properties as { metadata?: Readonly<Record<string, string>> }).metadata;
      return metadata?.[RULE_DERIVED_METADATA_KEY] !== 'true';
    })
    .map((n) => {
      const props = n.properties as { name?: string; description?: string };
      const label = props.name ?? '';
      const description = (props.description ?? '').trim();
      const lexicalText = description.length > 0 ? `${label} ${description}` : label;
      const sectionPath = n.metadata.sourceRefs[0]?.sectionPath ?? [];
      return { id: n.id, candidate: { sectionPath, lexicalText } };
    })
    .filter(({ candidate }) => candidate.sectionPath.length > 1); // root exclusion — see StructuralLinkCandidate's doc comment
}

/**
 * For every `source` in `ruleSources`, scores it against every existing
 * `capability`/`concept` node already present in `target` (via
 * `scoreLink`) and adds a `REQUIRES` edge (`source --REQUIRES-->
 * referencedNode`) wherever the score is sufficient. Idempotent per
 * `(source.nodeId, referencedNode.id)` pair — an edge id already present
 * in `target` is left alone rather than duplicated, so calling this
 * more than once (e.g. once for Stage 4 rule sources, once for Stage 7
 * ones, both against the same merged graph) is always safe.
 *
 * `target` must already contain every candidate capability/concept node
 * — callers are responsible for ordering (see `pipeline/compile.ts`'s
 * `convertToXoir` doc comment on why this matters).
 *
 * Problem C — after the same-unit scoring loop below runs unchanged for
 * a given `source`, this function additionally attempts exactly ONE
 * `structural_containment` link per source: the nearest (deepest
 * matching `sectionPath`) eligible capability ancestor — see
 * `buildStructuralCapabilityCandidates` — scored via
 * `scoreStructuralLink`. "Nearest" is selected purely by structural
 * depth, among candidates that are already valid structural ancestors,
 * BEFORE the lexical-corroboration check runs; if that single nearest
 * candidate fails corroboration, no structural link is created for this
 * source at all — this function deliberately does NOT fall back to a
 * more distant ancestor. Falling back would reintroduce, one level at a
 * time, exactly the "a broad, less-specific ancestor absorbs unrelated
 * content" risk the root-exclusion rule exists to prevent; the Problem C
 * investigation's own measurement showed this failure mode concretely
 * (a document-root capability absorbing all 21 reasoning nodes in the
 * clinical fixture), so this function only ever considers the single
 * most specific candidate.
 *
 * Because this reuses the exact same `req_<sourceId>_<capabilityId>`
 * edge-id scheme and the same idempotency check as the same-unit loop
 * above, a pair that already received a same-unit edge is left
 * completely alone — same-unit evidence, when it exists, always takes
 * precedence, and structural containment only ever fills in a pair that
 * has no edge yet. This is what guarantees B.1 and the existing
 * `exact_label`/`same_unit_term_overlap` behavior are entirely
 * unaffected, without any extra conditional logic to keep it that way.
 */
export function linkRuleSourcesToReferencedNodes(target: XoirGraph, ruleSources: readonly RuleLinkSource[], now: (() => string) | undefined): void {
  const referenceable = target
    .allNodes()
    .filter((n) => REFERENCEABLE_KINDS.has(n.kind))
    .filter((n) => {
      if (n.kind !== 'capability') return true;
      const metadata = (n.properties as { metadata?: Readonly<Record<string, string>> }).metadata;
      return metadata?.[RULE_DERIVED_METADATA_KEY] !== 'true'; // see doc comment above
    })
    .map((n) => {
      if (n.kind === 'capability') {
        const props = n.properties as { name?: string; description?: string };
        const label = props.name ?? '';
        // `description` is required on CapabilityNodeProps but this reads defensively — an
        // upstream node built outside the normal adapters is not this module's job to validate.
        const description = (props.description ?? '').trim();
        const sameUnitText = description.length > 0 ? `${label} ${description}` : label;
        const candidate: LinkCandidate = { label, experienceUnitId: n.metadata.sourceRefs[0]?.experienceUnitId, sameUnitText };
        return { id: n.id, candidate };
      }
      const label = (n.properties as { definition?: string }).definition ?? '';
      const candidate: LinkCandidate = { label, experienceUnitId: n.metadata.sourceRefs[0]?.experienceUnitId };
      return { id: n.id, candidate };
    })
    .filter((r) => r.candidate.label.length >= MIN_REFERENCE_LABEL_LENGTH);

  const candidateTermFrequency = buildCandidateTermFrequency(referenceable);
  const structuralCapabilityCandidates = buildStructuralCapabilityCandidates(target);

  for (const source of ruleSources) {
    if (source.searchableText.length === 0) continue;
    const fromId = XoirNodeId(source.nodeId);

    for (const ref of referenceable) {
      if (ref.id === fromId) continue;
      const score = scoreLink(source.searchableText, source.unitId, ref.candidate, candidateTermFrequency);
      if (!score) continue;
      const edgeId = XoirEdgeId(`req_${source.nodeId}_${ref.id}`);
      if (target.getEdge(edgeId).ok) continue;
      const evidence: XoirPropertyBag =
        score.evidence.kind === 'exact_label'
          ? { evidenceKind: 'exact_label', matchedLabel: score.evidence.matchedLabel ?? '' }
          : { evidenceKind: 'same_unit_term_overlap', sharedTerms: score.evidence.sharedTerms ?? [] };
      target.createAndAddEdge({
        id: edgeId,
        kind: 'REQUIRES',
        fromId,
        toId: ref.id,
        confidenceDetail: score.confidence,
        custom: evidence,
        ...(now !== undefined ? { now } : {}),
      });
    }

    // Problem C — structural containment, tried only after every
    // same-unit candidate above has already had its chance; see this
    // function's own doc comment for why exactly one, nearest-only
    // candidate is attempted and why no fallback exists.
    const reasoningNode = target.getNode(fromId);
    const reasoningSectionPath = reasoningNode.ok ? reasoningNode.value.metadata.sourceRefs[0]?.sectionPath : undefined;
    if (reasoningSectionPath !== undefined && reasoningSectionPath.length > 0) {
      const structuralAncestors = structuralCapabilityCandidates.filter(({ id, candidate }) => id !== fromId && isStrictSectionPathPrefix(candidate.sectionPath, reasoningSectionPath));
      if (structuralAncestors.length > 0) {
        const nearest = structuralAncestors.reduce((deepest, candidate) => (candidate.candidate.sectionPath.length > deepest.candidate.sectionPath.length ? candidate : deepest));
        const structuralScore = scoreStructuralLink(source.searchableText, reasoningSectionPath, nearest.candidate);
        if (structuralScore) {
          const edgeId = XoirEdgeId(`req_${source.nodeId}_${nearest.id}`);
          if (!target.getEdge(edgeId).ok) {
            const evidence: XoirPropertyBag = {
              evidenceKind: 'structural_containment',
              sharedTerms: structuralScore.evidence.sharedTerms ?? [],
              ancestorDepthGap: structuralScore.evidence.ancestorDepthGap ?? 0,
            };
            target.createAndAddEdge({
              id: edgeId,
              kind: 'REQUIRES',
              fromId,
              toId: nearest.id,
              confidenceDetail: structuralScore.confidence,
              custom: evidence,
              ...(now !== undefined ? { now } : {}),
            });
          }
        }
      }
    }
  }
}

/**
 * Creates exactly one deterministic `REQUIRES` edge — the originating
 * rule node -> its minted capability — for every M1.1-minted capability
 * present in `target` (identified via {@link RULE_DERIVED_METADATA_KEY}).
 * This is the counterpart to `linkRuleSourcesToReferencedNodes`
 * excluding minted capabilities from its generic same-unit-overlap
 * scoring: without *some* edge, an excluded capability would never bind
 * to anything at all. Confidence is fixed at `1` (this is a structural
 * fact derived directly from the minting step itself, not a heuristic
 * text-overlap guess) and the edge carries its own distinct evidence
 * kind (`rule_capability_derivation`) so it's clearly distinguishable
 * from `exact_label`/`same_unit_term_overlap` edges in audit/provenance
 * output.
 *
 * Idempotent per `(sourceNodeId, capabilityId)` pair, same convention as
 * `linkRuleSourcesToReferencedNodes`. Silently skips a minted capability
 * whose recorded source node id is not present in `target` (mirrors that
 * function's existing "missing endpoint is not an error" posture) —
 * this should not happen in practice (the minter only ever mints from a
 * rule node that is, by construction, converted into the same merged
 * graph — see `reasoning-to-xoir.ts`), but this function makes no
 * assumption about call order beyond "both nodes exist if minting and
 * conversion both ran correctly."
 */
export function linkMintedRuleCapabilities(target: XoirGraph, now: (() => string) | undefined): void {
  for (const node of target.allNodes()) {
    if (node.kind !== 'capability') continue;
    const metadata = (node.properties as { metadata?: Readonly<Record<string, string>> }).metadata;
    if (metadata?.[RULE_DERIVED_METADATA_KEY] !== 'true') continue;
    const sourceNodeId = metadata[RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY];
    if (sourceNodeId === undefined || sourceNodeId.length === 0) continue;

    const fromId = XoirNodeId(sourceNodeId);
    if (!target.getNode(fromId).ok) continue; // source rule node not present — nothing to link

    const edgeId = XoirEdgeId(`req_${sourceNodeId}_${node.id}`);
    if (target.getEdge(edgeId).ok) continue;
    const evidence: XoirPropertyBag = { evidenceKind: 'rule_capability_derivation', sourceNodeId };
    target.createAndAddEdge({
      id: edgeId,
      kind: 'REQUIRES',
      fromId,
      toId: node.id,
      confidenceDetail: confidenceFromScore(1, { basis: 'observed', evidenceStrength: 'strong', corroboration: 1, calibrated: false }),
      custom: evidence,
      ...(now !== undefined ? { now } : {}),
    });
  }
}

