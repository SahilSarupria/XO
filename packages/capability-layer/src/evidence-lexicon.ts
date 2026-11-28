import type { DecisionTree, TreeInput } from './decision-tree.js';

/**
 * Domain vocabulary for evidence checking, kept OUT of the runtime and out of the trees. The runtime knows how to check evidence
 * (topical cues, typed value patterns, recomputed derivations); what words and phrases mean "this sentence is about the declared
 * value" or "this sentence says the delivery receipt was signed clean" is business knowledge, and lives in the Business Knowledge
 * Base. A lexicon is whatever supplies it: the runtime only needs this interface, so it never depends on a knowledge store.
 */
export interface LexiconInput {
  /** Words or phrases that mark text as being about the input (matched at the start of a word, after lower-casing). */
  readonly cues?: readonly string[];
  /** For a boolean / fixed-label input: per value, patterns (regular expressions over the normalised text) that state it. */
  readonly valueEvidence?: readonly { readonly value: string | number | boolean; readonly patterns: readonly string[] }[];
}

export interface EvidenceLexicon {
  /** A stable name for the source (for the receipt), e.g. a BKB state id. */
  readonly id: string;
  /** Digest of the exact content in use: the signed load receipt binds it, so a change of vocabulary is a change of receipt. */
  readonly digest: string;
  /** What is known about one tree input, or undefined. `treeId` lets a source scope entries; sources are free to ignore it. */
  lookup(treeId: string, inputName: string): LexiconInput | undefined;
}

/**
 * Merges lexicon knowledge into a tree. The tree's own declarations stay; the lexicon ADDS cues (union) and supplies typed value
 * patterns where the tree has none. Returns the same tree object when the lexicon contributes nothing.
 */
export function applyLexicon(tree: DecisionTree, lexicon: EvidenceLexicon | undefined): DecisionTree {
  if (lexicon === undefined) return tree;
  let changed = false;
  const inputs = tree.inputs.map((i): TreeInput => {
    const known = lexicon.lookup(tree.id, i.name);
    if (known === undefined) return i;
    const cues = [...new Set([...(i.evidenceCues ?? []), ...(known.cues ?? [])])];
    const addCues = cues.length > (i.evidenceCues?.length ?? 0);
    const addValues = i.valueEvidence === undefined && known.valueEvidence !== undefined && known.valueEvidence.length > 0;
    if (!addCues && !addValues) return i;
    changed = true;
    return { ...i, ...(cues.length > 0 ? { evidenceCues: cues } : {}), ...(addValues ? { valueEvidence: known.valueEvidence! } : {}) };
  });
  return changed ? { ...tree, inputs } : tree;
}
