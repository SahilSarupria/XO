/**
 * Content classification: what KIND of information a sentence (and therefore a document) carries, decided BEFORE anyone
 * asks "what can XO generate from it". A policy yields decision rules, a procedure yields steps, a research abstract
 * yields reference knowledge and no rules at all — "compile anything" means understanding which of these it is, not
 * forcing every source into a rule.
 *
 * Deterministic, language-cue only (no subject-matter vocabulary), v0: it is a first-pass profile that is reported and
 * measured, NOT yet used to gate extraction. Every sentence gets exactly one kind; the document profile is a count.
 */
import { splitSentences } from '../capabilities/sentence-split.js';
import { classifyModality } from '../reasoning/modality.js';
import { classifyOutcomeType } from '../reasoning/outcome-type.js';

export type ContentKind = 'rule' | 'obligation' | 'permission' | 'prohibition' | 'procedure' | 'definition' | 'reference' | 'heading';

const DEFINITION = /\b(?:means|shall\s+mean|refers\s+to|is\s+defined\s+as|are\s+defined\s+as|stands\s+for)\b/i;
const HEADING = /^(?:#{1,6}\s|(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[IVX]+\.)\s+[A-Z][^.!?]{0,60}$)/;
/** A sentence that opens with a condition cue and has a comma is conditional by FORM: its main clause is an instruction or consequence even when it carries no modal ("If A, reorder the item"). */
const CONDITIONAL_FORM = /^(?:if|when|whenever|where|unless|provided\s+that|in\s+case)\b[^,]*,/i;
const BARE_IMPERATIVE_STEP =
  /^(?:\d+(?:\.\d+)*[.)]?\s+)?(?:open|close|log|record|submit|send|return|check|verify|confirm|review|notify|assign|create|update|delete|attach|enter|select|click|run|start|stop|complete|file|collect|prepare)\b/i;

export function classifySentenceKind(sentence: string): ContentKind {
  const text = sentence.trim().replace(/^(?:\d+(?:\.\d+)*[.)]?\s+)/, '');
  if (text.length === 0) return 'reference';
  if (HEADING.test(sentence.trim()) && !/[.!?]$/.test(sentence.trim())) return 'heading';
  if (DEFINITION.test(text)) return 'definition';

  const { modality } = classifyModality(text);
  const outcome = classifyOutcomeType(text);
  // A stated decision outcome (approve / deny / requires_approval / escalate) is a decision rule whatever its modality.
  if (outcome !== 'none' && modality !== 'prohibition' && modality !== 'permission') return 'rule';
  if (modality === 'prohibition' || modality === 'mixed') return 'prohibition';
  if (modality === 'permission') return outcome === 'none' ? 'permission' : 'permission';
  if (modality === 'obligation' || modality === 'advisory')
    return BARE_IMPERATIVE_STEP.test(sentence.trim()) && !/\b(?:must|shall|should)\b/i.test(text) ? 'procedure' : 'obligation';
  if (outcome !== 'none') return 'rule';
  if (CONDITIONAL_FORM.test(text)) return 'rule';
  return 'reference';
}

export interface ContentProfile {
  readonly total: number;
  readonly counts: Readonly<Record<ContentKind, number>>;
  /** Kinds from which XO can derive executable-style structure (rules, obligations, permissions, prohibitions, procedures). */
  readonly normativeCount: number;
  /** The most frequent kind among non-heading sentences (ties broken by the order of `ContentKind`); `undefined` for empty input. */
  readonly dominantKind: ContentKind | undefined;
}

const ALL_KINDS: readonly ContentKind[] = [
  'rule',
  'obligation',
  'permission',
  'prohibition',
  'procedure',
  'definition',
  'reference',
  'heading',
];

export function classifyContent(texts: readonly string[]): ContentProfile {
  const counts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<ContentKind, number>;
  let total = 0;
  for (const text of texts) {
    // Line first: a heading line ("## 1. Entry") must not be fused into the next sentence by the sentence splitter.
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (classifySentenceKind(trimmed) === 'heading') {
        counts.heading += 1;
        total += 1;
        continue;
      }
      for (const sentence of splitSentences(trimmed)) {
        counts[classifySentenceKind(sentence.text)] += 1;
        total += 1;
      }
    }
  }
  const normativeCount = counts.rule + counts.obligation + counts.permission + counts.prohibition + counts.procedure;
  let dominantKind: ContentKind | undefined;
  let best = 0;
  for (const kind of ALL_KINDS) {
    if (kind === 'heading') continue;
    if (counts[kind] > best) {
      best = counts[kind];
      dominantKind = kind;
    }
  }
  return { total, counts, normativeCount, dominantKind };
}
