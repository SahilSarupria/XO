/**
 * Silent-loss guard: finds sentences that the content classifier judges NORMATIVE (a rule, obligation, permission,
 * prohibition or procedure) but that no extracted reasoning node accounts for. Such a sentence was understood as
 * carrying meaning and then lost; it must be visible, never quietly absent.
 *
 * "Accounts for" is a token-overlap test (most of a node's content words appear in the sentence), deliberately lenient so
 * a node built from part of a sentence still counts. It is a diagnostic aid, not a proof: a miss means "may not have been
 * extracted". Language-level only, no subject-matter vocabulary.
 */
import { splitSentences } from '../capabilities/sentence-split.js';
import { classifySentenceKind, type ContentKind } from '../document/content-classification.js';

export interface NodeTexts {
  readonly texts: readonly string[];
}

export interface UncoveredSentence {
  readonly sentence: string;
  readonly kind: ContentKind;
}

const STOPWORDS = new Set(
  'the a an of to is are be by for in on or and if with that this any each than at as it its from not may must shall will'.split(' '),
);
const NORMATIVE: ReadonlySet<ContentKind> = new Set<ContentKind>(['rule', 'obligation', 'permission', 'prohibition', 'procedure']);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

export function uncoveredNormativeSentences(unitTexts: readonly string[], nodes: readonly NodeTexts[]): readonly UncoveredSentence[] {
  const nodeTokenLists = nodes.map((n) => tokens(n.texts.join(' '))).filter((t) => t.length >= 2);
  const out: UncoveredSentence[] = [];
  for (const unit of unitTexts) {
    for (const line of unit.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      for (const s of splitSentences(trimmed)) {
        const sentence = s.text.trim();
        if (/\?["'’”)\]]*$/.test(sentence)) continue; // UW-3c: a question states no rule, so it cannot have been lost as one
        const kind = classifySentenceKind(sentence);
        if (!NORMATIVE.has(kind)) continue;
        const sentenceTokens = new Set(tokens(sentence));
        if (sentenceTokens.size === 0) continue;
        const covered = nodeTokenLists.some((nt) => nt.filter((t) => sentenceTokens.has(t)).length / nt.length >= 0.6);
        if (!covered) out.push({ sentence, kind });
      }
    }
  }
  return out;
}
