import { Sha256Hasher } from '@xo/crypto';
import { brand } from '@xo/types';
import type { ReasoningNodeId, ReasoningNodeType } from './types.js';

const hasher = new Sha256Hasher();

function collapseWhitespace(text: string): string {
  let out = '';
  let lastWasSpace = false;
  for (const ch of text.trim()) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isSpace) {
      if (!lastWasSpace) out += ' ';
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  return out;
}

/**
 * Normalizes a canonical label for *matching* — same spirit as
 * `../knowledge/node-id.ts#normalizeForMatching`, but deliberately gentler:
 * whitespace-collapsed and lowercased only, punctuation preserved.
 * Reasoning labels already encode structure (`"<condition> => <action>"`)
 * where punctuation inside `condition`/`action` is meaningful content,
 * unlike an entity name where "OpenAI" vs "Open AI" is the same thing —
 * stripping punctuation here would risk conflating two different
 * conditions that happen to share the same words.
 */
export function normalizeReasoningLabel(label: string): string {
  return collapseWhitespace(label.toLowerCase());
}

export function computeReasoningMatchKey(nodeType: ReasoningNodeType, canonicalLabel: string): string {
  return `${nodeType}::${normalizeReasoningLabel(canonicalLabel)}`;
}

/**
 * A reasoning node's id is a content hash over its match key (node type +
 * normalized canonical label) — never over extraction order, source unit,
 * or which extractor (rule-based vs. AI) produced it, so the same rule
 * stated in two different units (or found by both extractors) converges
 * on one node id, and re-running extraction on identical input reproduces
 * byte-for-byte identical ids. Mirrors `../knowledge/node-id.ts#computeKnowledgeNodeId`.
 */
export function computeReasoningNodeId(nodeType: ReasoningNodeType, canonicalLabel: string): ReasoningNodeId {
  const matchKey = computeReasoningMatchKey(nodeType, canonicalLabel);
  return brand(`rn_${hasher.hash(matchKey).replace('sha256:', '').slice(0, 32)}`);
}

export function computeReasoningEdgeId(type: string, fromNodeId: string, toNodeId: string): string {
  return `re_${hasher.hash(JSON.stringify({ type, fromNodeId, toNodeId })).replace('sha256:', '').slice(0, 32)}`;
}
