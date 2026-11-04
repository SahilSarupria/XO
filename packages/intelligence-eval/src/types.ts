import type { HistoryTurn, LearningKind, Route } from '@xo/intelligence';

/** What each category measures. See docs/intelligence/EVALUATION.md. */
export type Category = 'ask' | 'evidence' | 'retrieval' | 'decide' | 'uncertainty' | 'routing' | 'security' | 'feedback' | 'do';
export const CATEGORIES: readonly Category[] = [
  'ask',
  'evidence',
  'retrieval',
  'decide',
  'uncertainty',
  'routing',
  'security',
  'feedback',
  'do',
];

export type PersonaId = 'analyst' | 'ops_manager' | 'finance' | 'exec';

/** A person asking. `groups` decide which restricted documents they may see (the fixture's stand-in for C6 authorization). */
export interface Persona {
  readonly id: PersonaId;
  readonly role: string;
  readonly groups: readonly string[];
}

export interface CorpusDoc {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly asOf: string;
  /** `'*'` = anyone; otherwise group names (a persona needs one of them). */
  readonly acl: readonly string[];
  readonly text: string;
}

/** A fact the answer must contain: a string, or a list of acceptable alternatives. Matched case- and comma-insensitively. */
export type Fact = string | readonly string[];

export interface Expect {
  readonly route: Route | 'clarify';
  /** Documents that hold the answer: they must be retrieved AND cited. */
  readonly goldDocs?: readonly string[];
  readonly facts?: readonly Fact[];
  /** Must not appear in what the user sees (answer, sources, notices): stale or fabricated values. May appear in prompts. */
  readonly forbidden?: readonly string[];
  /** Must not appear ANYWHERE, including everything sent to the model: restricted data the caller may not see (canaries). */
  readonly restricted?: readonly string[];
  /** The organization's sources do not answer this: no fabricated answer, low or no confidence. */
  readonly abstain?: boolean;
  /** Sources disagree: the conflict must be surfaced. */
  readonly conflict?: boolean;
  /** DECIDE: the recommended option must be one of these titles. */
  readonly recommendOneOf?: readonly string[];
  readonly noRecommendation?: boolean;
  // DO
  readonly proposal?: boolean;
  readonly capability?: string;
  readonly inputs?: Readonly<Record<string, string | number | boolean>>;
  readonly needsInput?: boolean;
  // LEARN
  readonly learningKind?: LearningKind;
}

/** Only the deterministic reference model reads this. A real model never sees it. `{{docId}}` becomes a citation marker. */
export interface Oracle {
  readonly query?: string;
  readonly answer?: string;
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly contradictions?: readonly { readonly summary: string; readonly docs: readonly string[] }[];
  readonly gaps?: readonly string[];
  readonly decide?: {
    readonly summary: string;
    readonly options: readonly { readonly title: string; readonly description: string; readonly docs: readonly string[] }[];
    readonly recommended: string;
    readonly rationale: string;
    readonly risks?: readonly { readonly description: string; readonly severity: 'low' | 'medium' | 'high' }[];
  };
  readonly capabilityName?: string;
  readonly inputs?: readonly { readonly name: string; readonly value: string }[];
  readonly question?: string;
  readonly learnKind?: LearningKind;
  readonly statement?: string;
  readonly clarify?: string;
}

export interface EvalItem {
  readonly id: string;
  readonly category: Category;
  readonly persona: PersonaId;
  readonly message: string;
  readonly history?: readonly HistoryTurn[];
  readonly expect: Expect;
  readonly oracle?: Oracle;
  /**
   * The item needs retrieval beyond keyword matching (paraphrase, synonyms). Run and reported, but not counted toward
   * gates while the knowledge source is keyword-only: failing them measures the source, not the chat.
   */
  readonly knownLimit?: 'lexical';
}

export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface ItemResult {
  readonly id: string;
  readonly category: Category;
  readonly pass: boolean;
  readonly knownLimit: boolean;
  readonly checks: readonly CheckResult[];
  readonly route?: string;
  readonly confidence?: string;
  readonly modelCalls: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly retrieval?: { readonly goldDocs: number; readonly retrieved: number };
  readonly citations?: { readonly goldDocs: number; readonly cited: number; readonly total: number; readonly unsupported: number };
  readonly error?: string;
}
