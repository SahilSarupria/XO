import { WireParseError, arr, bool, num, obj, optStr, str, strArr } from './wire';

/**
 * S1-3b — what `POST /workspaces/{ws}/ask` returns: exactly one typed answer. Mirrors apps/api/src/ask/ask-types.ts. A kind this Studio
 * does not know is a malformed answer, never guessed at.
 */

export const ASK_PLACES = ['home', 'inbox', 'work', 'sources', 'knowledge', 'activity', 'settings'] as const;
export type AskPlace = (typeof ASK_PLACES)[number];

/** Where the person is when they ask. */
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
      readonly canUseAsSource: boolean;
    }
  | {
      readonly kind: 'start';
      readonly summary: string;
      readonly workflow?: { readonly workflowId: string; readonly name: string };
      readonly ready: boolean;
      readonly why?: string;
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

function place(v: unknown, path: string): AskPlace {
  const s = str(v, path);
  if (!(ASK_PLACES as readonly string[]).includes(s)) throw new WireParseError(path, `one of ${ASK_PLACES.join(', ')}`);
  return s as AskPlace;
}

export function parseAskReply(body: unknown): AskAnswer {
  const a = obj(obj(body, 'response').answer, 'answer');
  const kind = str(a.kind, 'answer.kind');
  switch (kind) {
    case 'answer':
      return {
        kind,
        text: str(a.text, 'answer.text'),
        grounded: bool(a.grounded, 'answer.grounded'),
        confidence: str(a.confidence, 'answer.confidence'),
        citations: arr(a.citations, 'answer.citations').map((c, i) => {
          const o = obj(c, `answer.citations[${i}]`);
          return {
            index: num(o.index, `answer.citations[${i}].index`),
            sourceName: str(o.sourceName, `answer.citations[${i}].sourceName`),
            ...(o.sourceType !== undefined ? { sourceType: str(o.sourceType, `answer.citations[${i}].sourceType`) } : {}),
            excerpt: str(o.excerpt, `answer.citations[${i}].excerpt`),
            ...(o.asOf !== undefined ? { asOf: str(o.asOf, `answer.citations[${i}].asOf`) } : {}),
          };
        }),
        notices: strArr(a.notices, 'answer.notices'),
      };
    case 'analyse': {
      const found = obj(a.found, 'answer.found');
      const status = str(a.status, 'answer.status');
      if (status !== 'succeeded' && status !== 'failed') throw new WireParseError('answer.status', 'succeeded or failed');
      const pages = found.pages === undefined ? undefined : obj(found.pages, 'answer.found.pages');
      return {
        kind,
        documentId: str(a.documentId, 'answer.documentId'),
        fileName: str(a.fileName, 'answer.fileName'),
        status,
        ...(a.compilationId !== undefined ? { compilationId: str(a.compilationId, 'answer.compilationId') } : {}),
        summary: str(a.summary, 'answer.summary'),
        found: {
          documentKinds: arr(found.documentKinds, 'answer.found.documentKinds').map((k, i) => {
            const o = obj(k, `answer.found.documentKinds[${i}]`);
            return {
              kind: str(o.kind, 'kind'),
              label: str(o.label, 'label'),
              evidence: arr(o.evidence, 'evidence').map((e) => {
                const x = obj(e, 'evidence');
                return { matched: str(x.matched, 'matched'), where: str(x.where, 'where') };
              }),
            };
          }),
          stepCount: num(found.stepCount, 'answer.found.stepCount'),
          ...(pages !== undefined ? { pages: { total: num(pages.total, 'total'), read: num(pages.read, 'read') } } : {}),
        },
        canUseAsSource: bool(a.canUseAsSource, 'answer.canUseAsSource'),
      };
    }
    case 'start': {
      const w = a.workflow === undefined ? undefined : obj(a.workflow, 'answer.workflow');
      const p = a.proposal === undefined ? undefined : obj(a.proposal, 'answer.proposal');
      return {
        kind,
        summary: str(a.summary, 'answer.summary'),
        ...(w !== undefined ? { workflow: { workflowId: str(w.workflowId, 'workflowId'), name: str(w.name, 'name') } } : {}),
        ready: bool(a.ready, 'answer.ready'),
        ...(optStr(a.why, 'answer.why') !== undefined ? { why: str(a.why, 'answer.why') } : {}),
        ...(p !== undefined ? { proposal: { goal: str(p.goal, 'goal'), compilationId: str(p.compilationId, 'compilationId') } } : {}),
      };
    }
    case 'navigate':
      return {
        kind,
        place: place(a.place, 'answer.place'),
        label: str(a.label, 'answer.label'),
        ...(optStr(a.workflowId, 'answer.workflowId') !== undefined ? { workflowId: str(a.workflowId, 'answer.workflowId') } : {}),
        ...(optStr(a.runId, 'answer.runId') !== undefined ? { runId: str(a.runId, 'answer.runId') } : {}),
      };
    case 'cannot':
      return { kind, reason: str(a.reason, 'answer.reason'), whatWouldHelp: str(a.whatWouldHelp, 'answer.whatWouldHelp') };
    default:
      throw new WireParseError('answer.kind', 'answer, analyse, start, navigate or cannot');
  }
}
