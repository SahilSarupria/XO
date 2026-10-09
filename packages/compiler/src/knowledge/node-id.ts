import { Sha256Hasher } from '@xo/crypto';
import { brand } from '@xo/types';
import type { KnowledgeNodeId, KnowledgeNodeType } from './types.js';

const hasher = new Sha256Hasher();

const CORPORATE_SUFFIXES = ['inc.', 'inc', 'llc', 'l.l.c.', 'ltd.', 'ltd', 'corp.', 'corp', 'corporation', 'co.', 'co'];

function stripTrailingCorporateSuffix(lower: string): string {
  for (const suffix of CORPORATE_SUFFIXES) {
    if (lower.endsWith(` ${suffix}`)) return lower.slice(0, lower.length - suffix.length - 1).trimEnd();
  }
  return lower;
}

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

function isAlphanumeric(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

function keepOnlyAlphanumeric(text: string): string {
  let out = '';
  for (const ch of text) {
    if (isAlphanumeric(ch)) out += ch;
  }
  return out;
}

/**
 * Normalizes a surface form for *matching* (never shown to a caller — the
 * node's own `canonicalLabel` keeps a readable, real surface form). This
 * is what makes "OpenAI", "Open AI", and "OpenAI Inc." resolve to the
 * same node: lowercase, whitespace collapsed then removed entirely, and
 * a trailing corporate suffix stripped. Removing whitespace entirely is
 * a deliberately aggressive, precision-losing choice — documented in the
 * package README as a real limitation, not hidden — but it's the one
 * rule that actually unifies "Open AI" with "OpenAI" deterministically
 * without any ML-based fuzzy matching.
 */
export function normalizeForMatching(label: string): string {
  const collapsedWhitespace = collapseWhitespace(label.toLowerCase());
  const suffixStripped = stripTrailingCorporateSuffix(collapsedWhitespace);
  return keepOnlyAlphanumeric(suffixStripped);
}

export function computeMatchKey(semanticType: KnowledgeNodeType, label: string): string {
  return `${semanticType}::${normalizeForMatching(label)}`;
}

/**
 * A node's id is a content hash over its *match key* (semantic type +
 * normalized label), never over which surface form happened to be seen
 * first or over any per-extraction detail — so two candidate nodes that
 * merge into "the same concept" always converge on the same id
 * regardless of extraction order, and re-running the whole stage on
 * identical input reproduces byte-for-byte identical ids.
 */
export function computeKnowledgeNodeId(semanticType: KnowledgeNodeType, label: string): KnowledgeNodeId {
  const matchKey = computeMatchKey(semanticType, label);
  return brand(`kn_${hasher.hash(matchKey).replace('sha256:', '').slice(0, 32)}`);
}

export function computeKnowledgeEdgeId(type: string, fromNodeId: string, toNodeId: string): string {
  return `ke_${hasher.hash(JSON.stringify({ type, fromNodeId, toNodeId })).replace('sha256:', '').slice(0, 32)}`;
}
