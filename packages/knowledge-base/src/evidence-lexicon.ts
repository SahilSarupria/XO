/**
 * Evidence vocabulary in the Business Knowledge Base.
 *
 * The runtime that checks evidence (@xo/capability-layer) is domain-agnostic: it checks that a quote is on topic, that it says the
 * value supplied, that a case does not contradict itself, that a computed value is recomputed. Which words are "on topic" for a
 * declared value, or which phrase says a delivery receipt was signed clean, is business knowledge. It is stored here as ordinary
 * governed records (proposed, reviewed, versioned, bound to a state digest) in the core vocabulary, and handed to the runtime
 * through a structurally typed lexicon. This module knows no domain and does not import the runtime.
 */
import { digestOf } from './canonical.js';
import type { KnowledgeBase } from './knowledge-base.js';
import type { EntityRecord, EvidenceRef } from './types.js';

/** Core (domain-agnostic) record type: one entry describes how evidence for one concept is recognised in text. */
export const EVIDENCE_LEXICON_TYPE = 'xo:EvidenceLexiconEntry';

export interface EvidenceLexiconEntryAttributes {
  /** The business concept this entry is about (free text key, e.g. "declared value"). */
  readonly concept: string;
  /** Names a rule input goes by that mean this concept (e.g. both a hand-built and a compiled input name). */
  readonly names: readonly string[];
  /** Restrict the entry to these rule-tree ids; empty or absent: any tree. */
  readonly trees?: readonly string[];
  /** Words / phrases that mark text as being about the concept. */
  readonly cues?: readonly string[];
  /** For a boolean or fixed-label concept: per value, regular expressions (over lower-cased, punctuation-stripped text) that state it. */
  readonly values?: readonly { readonly value: string | number | boolean; readonly patterns: readonly string[] }[];
}

/** Builds the governed record for one entry. Propose it in a change set; it only takes effect when a reviewer approves. */
export function evidenceLexiconRecord(
  tenantId: string,
  attrs: EvidenceLexiconEntryAttributes,
  evidence: readonly EvidenceRef[],
  recordedAt: string,
): EntityRecord {
  const key = digestOf({ tenantId, type: EVIDENCE_LEXICON_TYPE, concept: attrs.concept, trees: attrs.trees ?? [] }).slice('sha256:'.length, 'sha256:'.length + 24);
  return {
    kind: 'entity',
    id: `ent_${key}`,
    tenantId,
    type: EVIDENCE_LEXICON_TYPE,
    canonicalName: attrs.concept,
    aliases: [...attrs.names],
    identifiers: [],
    attributes: JSON.parse(JSON.stringify(attrs)) as EntityRecord['attributes'],
    evidence: [...evidence],
    derivation: 'human',
    confidence: 1,
    recordedAt,
  };
}

/** The lexicon as the runtime consumes it (structurally the same as the capability layer's EvidenceLexicon; no import needed). */
export interface BkbEvidenceLexicon {
  readonly id: string;
  readonly digest: string;
  lookup(treeId: string, inputName: string):
    | {
        readonly cues?: readonly string[];
        readonly valueEvidence?: readonly { readonly value: string | number | boolean; readonly patterns: readonly string[] }[];
      }
    | undefined;
}

/**
 * Reads the ACTIVE evidence-lexicon entries of a knowledge state (default: the head) into a lexicon. Proposed, rejected, superseded
 * and expired entries do not count. The digest is the state's content root, so any approved change to the vocabulary changes it.
 */
export async function loadEvidenceLexicon(kb: KnowledgeBase, stateId?: string): Promise<BkbEvidenceLexicon> {
  const state = stateId === undefined ? await kb.head() : await kb.state(stateId);
  const rows = await kb.records(state.stateId, { kind: 'entity', type: EVIDENCE_LEXICON_TYPE });
  const entries = rows
    .map((r) => r.record)
    .filter((r): r is EntityRecord => r.kind === 'entity')
    .map((r) => r.attributes as unknown as EvidenceLexiconEntryAttributes);
  const digest = await kb.contentRoot(state.stateId);
  return {
    id: `bkb:${kb.tenantId}:${state.stateId}`,
    digest,
    lookup(treeId, inputName) {
      const hits = entries.filter((e) => e.names.includes(inputName) && (e.trees === undefined || e.trees.length === 0 || e.trees.includes(treeId)));
      if (hits.length === 0) return undefined;
      const cues = [...new Set(hits.flatMap((e) => e.cues ?? []))];
      const values = hits.find((e) => e.values !== undefined && e.values.length > 0)?.values;
      return { ...(cues.length > 0 ? { cues } : {}), ...(values !== undefined ? { valueEvidence: values } : {}) };
    },
  };
}
