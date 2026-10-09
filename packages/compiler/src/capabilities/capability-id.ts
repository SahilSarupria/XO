import { Sha256Hasher } from '@xo/crypto';
import { brand } from '@xo/types';
import type { CapabilityCategory, CapabilityId } from './types.js';

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

function isAlphanumericOrSpace(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === ' ';
}

function keepOnlyAlphanumericAndSpace(text: string): string {
  let out = '';
  for (const ch of text) {
    if (isAlphanumericOrSpace(ch)) out += ch;
  }
  return out;
}

/**
 * Normalizes a capability name for *matching* — lowercase, punctuation
 * stripped, whitespace collapsed to single spaces (unlike
 * `../knowledge/node-id.ts`'s entity matching, spaces are kept here
 * rather than removed entirely, since capability names are
 * verb-phrases where word boundaries carry real meaning: "Send Email"
 * and "Sendemail" are not the same kind of near-miss "OpenAI"/"Open AI"
 * is). This is what makes "Send Email", "Email Sending", and "Mail
 * Sender" all resolve to the same normalized key once each is reduced to
 * its sorted, deduplicated significant words — see `wordSetKey`.
 */
export function normalizeCapabilityName(name: string): string {
  return keepOnlyAlphanumericAndSpace(collapseWhitespace(name.toLowerCase()));
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or']);

/** A small, fixed synonym table for common capability-name synonyms — real, but deliberately narrow (not general NLP synonym understanding); see the package README's "Known limitations." */
const SYNONYMS: Readonly<Record<string, string>> = {
  mail: 'email',
  msg: 'message',
};

/**
 * A crude, deterministic suffix-stripping stemmer — enough to fold
 * "sending"/"sender" down to "send", not a real linguistic stemmer
 * (no exception dictionary, no handling of irregular forms). Tries the
 * longest matching suffix first so "sending" strips to "send" rather
 * than stopping at a shorter, wrong match; never strips a suffix if
 * doing so would leave fewer than 3 characters.
 */
const SUFFIXES_LONGEST_FIRST = ['ing', 'ers', 'er', 'ed', 's'];
function stem(word: string): string {
  for (const suffix of SUFFIXES_LONGEST_FIRST) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/**
 * Reduces a normalized name to its sorted, deduplicated set of
 * significant word stems (stop words removed, synonyms folded, each
 * remaining word stemmed) — this is what makes "Send Email", "Email
 * Sending", and "Mail Sender" all resolve to the same key
 * (`"email send"`), per this stage's own worked example: none of the
 * three share an exact word, but each reduces to the stems `{send,
 * email}` once "sending"/"sender" stem to "send" and "mail" maps to
 * "email". This is a pragmatic, explicitly-approximate technique (a
 * fixed synonym table plus a crude stemmer, not real NLP) — see the
 * package README's "Known limitations" for exactly what it does and
 * doesn't catch.
 */
function wordSetKey(normalizedName: string): string {
  const words = normalizedName
    .split(' ')
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .map((w) => SYNONYMS[w] ?? w)
    .map(stem)
    .map((w) => SYNONYMS[w] ?? w);
  return [...new Set(words)].sort().join(' ');
}

export function computeCapabilityMatchKey(category: CapabilityCategory, name: string): string {
  return `${category}::${wordSetKey(normalizeCapabilityName(name))}`;
}

/**
 * A capability's id is a content hash over its match key (category +
 * word-set key), never over which surface form or extractor produced it
 * first — so "Send Email"/"Email Sending"/"Mail Sender" converge on the
 * same id, and re-running this stage on identical input reproduces
 * byte-for-byte identical ids.
 */
export function computeCapabilityId(category: CapabilityCategory, name: string): CapabilityId {
  const matchKey = computeCapabilityMatchKey(category, name);
  return brand(`cap_${hasher.hash(matchKey).replace('sha256:', '').slice(0, 32)}`);
}

export function computeCapabilityRelationshipId(type: string, fromId: string, toId: string): string {
  return `cr_${hasher.hash(JSON.stringify({ type, fromId, toId })).replace('sha256:', '').slice(0, 32)}`;
}
