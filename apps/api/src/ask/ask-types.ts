/**
 * S1-3b — the Ask box's wire types. One request, one typed answer (never a mixture):
 *
 *   answer    a reply grounded in the workspace, with citations; `grounded: false` says so plainly
 *   analyse   what XO found in one uploaded document, and an offer to use it as a source
 *   start     a PREPARED start for a person to confirm (or a proposed workflow to create); nothing has started
 *   navigate  somewhere in Studio
 *   cannot    why not, and what would make it possible
 *
 * The route never starts a run, approves or changes anything on its own. A prepared start is confirmed through the existing,
 * gated routes (readiness certificate, approvals, effect authorisation), so those rules are unchanged.
 */

export const ASK_PLACES = ['home', 'inbox', 'work', 'sources', 'knowledge', 'activity', 'settings'] as const;
export type AskPlace = (typeof ASK_PLACES)[number];

export const PLACE_LABEL: Readonly<Record<AskPlace, string>> = {
  home: 'Home',
  inbox: 'Inbox',
  work: 'Work',
  sources: 'Sources',
  knowledge: 'Knowledge',
  activity: 'Activity',
  settings: 'Settings',
};

/** Where the person is when they ask. Ids are checked against the workspace; a stranger's id is the same as no id. */
export interface AskContext {
  readonly place: AskPlace;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly documentId?: string;
}

export interface AskCitation {
  readonly index: number;
  readonly sourceName: string;
  readonly sourceType?: string;
  readonly excerpt: string;
  readonly asOf?: string;
}

export interface AskFinding {
  readonly kind: string;
  readonly label: string;
  /** The document's own words that led XO to propose this kind. */
  readonly evidence: readonly { readonly matched: string; readonly where: string }[];
}

export type AskAnswer =
  | {
      readonly kind: 'answer';
      readonly text: string;
      readonly grounded: boolean;
      readonly confidence: string;
      readonly citations: readonly AskCitation[];
      readonly notices: readonly string[];
    }
  | {
      readonly kind: 'analyse';
      readonly documentId: string;
      readonly fileName: string;
      readonly status: 'succeeded' | 'failed';
      readonly compilationId?: string;
      readonly summary: string;
      readonly found: {
        readonly documentKinds: readonly AskFinding[];
        readonly stepCount: number;
        readonly pages?: { readonly total: number; readonly read: number };
      };
      /** True when the analysis worked: Studio then offers "Use it as a source". */
      readonly canUseAsSource: boolean;
    }
  | {
      readonly kind: 'start';
      readonly summary: string;
      /** An existing workflow to start. */
      readonly workflow?: { readonly workflowId: string; readonly name: string };
      /** True only when the check before starting has passed and nothing is running or stopped. Studio opens the normal start. */
      readonly ready: boolean;
      /** Plain words: why it cannot start yet, and what to do. Absent when ready. */
      readonly why?: string;
      /** No such workflow yet: a workflow XO can create from this goal and these sources. Creating is not starting. */
      readonly proposal?: { readonly goal: string; readonly compilationId: string };
    }
  | {
      readonly kind: 'navigate';
      readonly place: AskPlace;
      readonly label: string;
      readonly workflowId?: string;
      readonly runId?: string;
    }
  | { readonly kind: 'cannot'; readonly reason: string; readonly whatWouldHelp: string };

export type InterpretedKind = 'answer' | 'analyse' | 'start' | 'navigate' | 'cannot';

/** What the model chose. Every id in it is checked by the server before it is used. */
export interface Interpretation {
  readonly kind: InterpretedKind;
  readonly workflowId: string;
  readonly place: string;
  readonly goal: string;
  readonly reason: string;
}
