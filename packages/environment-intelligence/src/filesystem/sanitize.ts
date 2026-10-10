/**
 * Filenames and file contents are untrusted input. A name is accepted only
 * if it contains no control characters, no Unicode "format" characters
 * (bidi overrides, zero-width), and is within the length limit; anything
 * else is skipped and COUNTED, never stored, so a hostile name cannot be
 * smuggled into evidence, logs, or an LLM prompt downstream.
 */

const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

export function isSafeName(name: string, maxLength: number): boolean {
  if (name.length === 0 || name.length > maxLength) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return !CONTROL_OR_FORMAT.test(name);
}

/** Business-identifier shape this milestone knows how to extract: 2-5 capitals, dash, 3-8 digits (e.g. INV-1042). */
const IDENTIFIER = /\b[A-Z]{2,5}-\d{3,8}\b/g;

export const MAX_IDENTIFIERS_PER_ITEM = 50;

/**
 * Strictly pattern-bounded token extraction. This is the ONLY way text is
 * "understood" in this milestone: a regex over the characters, never an
 * interpreter of instructions. Text like "ignore previous instructions"
 * produces no tokens and changes no behaviour.
 */
export function extractIdentifiers(text: string): { readonly identifiers: readonly string[]; readonly truncated: boolean } {
  const found = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER)) {
    found.add(m[0]);
    if (found.size > MAX_IDENTIFIERS_PER_ITEM) break;
  }
  const sorted = [...found].sort();
  return { identifiers: sorted.slice(0, MAX_IDENTIFIERS_PER_ITEM), truncated: sorted.length > MAX_IDENTIFIERS_PER_ITEM };
}
