/**
 * UW-13 — the shapes every evaluation suite shares. One harness, many suites: each suite measures one thing XO claims, on a labelled
 * set whose provenance (synthetic or real) and content hash are part of the result, so a number can always be traced to exactly
 * what it was measured on.
 */

/** A labelled set a suite measured. Real-document sets are what UAC-19 ultimately needs; synthetic sets are labelled as such. */
export interface LabelledSetInfo {
  readonly id: string;
  readonly version: string;
  readonly provenance: 'synthetic' | 'real';
  readonly cases: number;
  /** SHA-256 over the set's canonical content: the same hash means the same set. */
  readonly contentHash: string;
  readonly description: string;
}

export interface Measure {
  /** `<suite>/<measure>`, the key thresholds refer to. */
  readonly id: string;
  readonly title: string;
  /** A ratio in [0, 1], or a count. */
  readonly unit: 'ratio' | 'count';
  /** Which way is better, so a threshold can be checked without knowing the measure. */
  readonly better: 'higher' | 'lower';
  /** `null` when there was nothing to measure (no cases): reported as such, never as 0%. */
  readonly value: number | null;
  readonly numerator?: number;
  readonly denominator?: number;
}

export interface SuiteResult {
  readonly suite: string;
  readonly title: string;
  /** Acceptance criteria the suite provides evidence for. */
  readonly uac: readonly string[];
  /** `deterministic` runs give the same numbers every time; `live` runs (a real model) do not, and say so. */
  readonly mode: 'deterministic' | 'live';
  readonly sets: readonly LabelledSetInfo[];
  readonly measures: readonly Measure[];
  /** Short findings worth reading next to the numbers (the cases that missed, a known limit). Never customer content. */
  readonly notes: readonly string[];
  /** What the numbers do NOT show. Every suite states its limits. */
  readonly limits: readonly string[];
}

export interface Suite {
  readonly id: string;
  readonly title: string;
  /** A slow suite (spawns processes, or calls a model) is skipped by `--fast`. */
  readonly slow?: boolean;
  run(): Promise<SuiteResult>;
}

/**
 * A pass criterion for one measure. Until the owner ratifies it, a threshold is a PROPOSAL: shown next to the measure, never a gate
 * (UAC-19: thresholds are ratified by the owner beforehand, not chosen after seeing the numbers).
 */
export interface Threshold {
  readonly measure: string;
  readonly min?: number;
  readonly max?: number;
  readonly status: 'proposed' | 'ratified';
  readonly rationale: string;
  readonly ratifiedBy?: string;
  readonly ratifiedAt?: string;
}

/** One entry of the R1-R18 commercial readiness register (UAC-20). */
export interface RegisterItem {
  readonly id: string;
  readonly title: string;
  /** Whether it blocks a first pilot with real customer data. */
  readonly pilotBlocking: boolean;
  /** Who is accountable: `owner`, `counsel`, or `engineering (UW-n)`. */
  readonly owner: string;
  readonly status: 'open' | 'in_progress' | 'closed' | 'accepted';
  /** Where the evidence is (files, pull requests, decisions). */
  readonly evidence: readonly string[];
  readonly next?: string;
  /** Required for `accepted`: who accepted the remaining risk, and when. */
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
  /** Set when the plan text does not record the item's title and it must be confirmed from the source audit. */
  readonly titleUnconfirmed?: boolean;
}
