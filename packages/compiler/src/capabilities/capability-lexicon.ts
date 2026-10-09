import type { CapabilityCategory } from './types.js';

/**
 * Maps common capability-indicating verbs to a category. Used by
 * `rule-based-extractor.ts` to detect an imperative-mood or modal-verb
 * ("shall send", "must validate") clause as evidence of a capability —
 * the same shallow-lexical-cue technique Stage 3's `lexical-cues.ts` and
 * Stage 4's suffix-stripping use, applied to a new vocabulary. Not
 * exhaustive; extending this table is additive, not a redesign.
 *
 * No stemming/inflection normalization exists anywhere in this lookup
 * (`findCapabilityVerb` in `rule-based-extractor.ts` does an exact
 * lowercase dictionary match per word) — every entry below, like every
 * pre-existing entry above it, is listed only in its base/imperative
 * form ("match", not "matches"/"matched"/"matching"). This is a
 * pre-existing, consistent limitation across the whole table, not
 * something newly introduced here; verified before extending this table
 * rather than assumed.
 */
export const CAPABILITY_VERBS: Readonly<Record<string, KnownCategoryValue>> = {
  send: 'communication',
  notify: 'communication',
  email: 'communication',
  message: 'communication',
  contact: 'communication',
  inform: 'communication',
  generate: 'generation',
  create: 'generation',
  draft: 'generation',
  produce: 'generation',
  write: 'generation',
  compose: 'generation',
  extract: 'extraction',
  identify: 'extraction',
  parse: 'extraction',
  retrieve: 'retrieval',
  fetch: 'retrieval',
  obtain: 'retrieval',
  collect: 'retrieval',
  search: 'search',
  find: 'search',
  locate: 'search',
  lookup: 'search',
  analyze: 'analysis',
  review: 'analysis',
  assess: 'analysis',
  evaluate: 'analysis',
  inspect: 'analysis',
  examine: 'analysis',
  translate: 'translation',
  convert: 'transformation',
  transform: 'transformation',
  format: 'transformation',
  validate: 'validation',
  verify: 'validation',
  check: 'validation',
  confirm: 'validation',
  execute: 'execution',
  run: 'execution',
  perform: 'execution',
  invoke: 'execution',
  plan: 'planning',
  schedule: 'planning',
  organize: 'planning',
  classify: 'classification',
  categorize: 'classification',
  label: 'classification',
  summarize: 'summarization',
  condense: 'summarization',
  reason: 'reasoning',
  infer: 'reasoning',
  determine: 'reasoning',
  decide: 'reasoning',
  // Cross-domain operational verbs confirmed missing by the Action/Process
  // Realization investigation's 29-sentence, 4-domain measurement harness
  // (insurance/operations, API documentation, technical checklist,
  // general handbook) — additive only, following this table's existing
  // convention of listing the base/imperative form only (see the
  // package-level note on inflected forms below).
  match: 'validation',
  reconcile: 'validation',
  authenticate: 'validation',
  calculate: 'transformation',
  handle: 'execution',
  retry: 'execution',
  install: 'execution',
  configure: 'execution',
  restart: 'execution',
  deploy: 'execution',
  record: 'generation',
  book: 'generation',
  escalate: 'communication',
  // Additional cross-domain operational verbs confirmed missing by direct
  // diff against real document evidence (Aastha.pdf): "Request…" (Statement
  // Collection) and "Map…" (Data Mapping) both went entirely undetected,
  // surviving only as generic concept nodes rather than capabilities.
  // Additive only, same base/imperative-form-only convention as above.
  request: 'retrieval',
  map: 'transformation',
};

type KnownCategoryValue = Exclude<CapabilityCategory, `custom:${string}`>;

/** Maps a keyword found in a section heading/unit title to a category — a heading like "Notification Process" or "Risk Analysis" is itself evidence of a capability, independent of any single verb inside its body text. */
export const CATEGORY_TITLE_KEYWORDS: Readonly<Record<string, KnownCategoryValue>> = {
  process: 'workflow',
  procedure: 'workflow',
  workflow: 'workflow',
  analysis: 'analysis',
  review: 'analysis',
  assessment: 'analysis',
  search: 'search',
  translation: 'translation',
  validation: 'validation',
  verification: 'validation',
  summary: 'summarization',
  summarization: 'summarization',
  extraction: 'extraction',
  classification: 'classification',
  categorization: 'classification',
  generation: 'generation',
  drafting: 'generation',
  retrieval: 'retrieval',
  communication: 'communication',
  notification: 'communication',
  planning: 'planning',
  scheduling: 'planning',
  reasoning: 'reasoning',
  transformation: 'transformation',
  conversion: 'transformation',
  execution: 'execution',
  // "Invoicing" as a section heading is itself evidence of a capability
  // (e.g. an "Invoicing" section whose body describes invoices being
  // created) even when the body text uses passive voice the verb-based
  // signal alone can't catch without help (see PASSIVE_AUX_WORDS below).
  invoicing: 'generation',
  invoice: 'generation',
};

/**
 * Modal/passive-auxiliary words a capability-indicating verb's *past
 * participle* can follow in a passive-voice obligation clause ("invoices
 * are created", "the report is generated") — checked so the verb search
 * also recognizes passive phrasing, not just true imperatives
 * (`MODAL_WORDS` below) already covers active modal-obligation phrasing.
 * This does not add general stemming/inflection matching to the lexicon
 * lookup itself (`findCapabilityVerb`'s exact-match dictionary lookup is
 * unchanged) — it only lets `rule-based-extractor.ts` try a small,
 * deterministic regular-participle-to-base transform (see
 * `derivePassiveBaseVerb` there) *specifically* when the word immediately
 * follows one of these auxiliaries, so an unrelated past-tense word
 * elsewhere in a sentence is never affected.
 */
export const PASSIVE_AUX_WORDS = new Set(['is', 'are', 'was', 'were', 'being']);

/** Modal words a capability-indicating verb often follows in an obligation clause ("shall notify", "must validate") — checked so the verb search also works on non-imperative, modal-obligation phrasing typical of contract text, not just true sentence-initial imperatives. */
export const MODAL_WORDS = new Set(['shall', 'must', 'will', 'may', 'should']);
