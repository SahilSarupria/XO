import { scriptedReply, type ScriptedReply } from './home';

/**
 * The conversation screen. Replies are fixed, chosen by keyword, and point at real places in Studio (see scriptedReply).
 * The only facts a reply may state are counts the platform actually returned; a reply never says it did something,
 * never produces content about the person's documents, and never claims to have read an attached XO.
 */
export interface ChatMessage {
  readonly id: number;
  readonly from: 'you' | 'xo';
  readonly text: string;
  readonly action?: ScriptedReply['action'];
  /** XOs the person attached to this message (shown as chips; the preview does not read them). */
  readonly attached?: readonly string[];
}

export interface ChatThread {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ChatMessage[];
}

/** Counts straight from the platform's lists; undefined = not loaded, so nothing is claimed. */
export interface ChatFacts {
  readonly documents: number | undefined;
  readonly analyses: number | undefined;
  readonly processes: number | undefined;
  readonly runs: number | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function threadTitle(firstMessage: string): string {
  const t = firstMessage.replace(/\s+/g, ' ').trim();
  return t.length <= 36 ? t : `${t.slice(0, 35).trimEnd()}…`;
}

export function chatReply(input: string, facts: ChatFacts, attached: readonly string[] = []): ScriptedReply {
  const q = input.toLowerCase();
  const note =
    attached.length === 0
      ? ''
      : ` You attached ${attached.join(', ')}; this preview shows attachments for context only and does not read them.`;
  if (/(status|summary|overview|what do i have|what have i got)/.test(q)) {
    const known = [
      facts.documents !== undefined ? plural(facts.documents, 'document') : undefined,
      facts.analyses !== undefined ? plural(facts.analyses, 'analysis', 'analyses') : undefined,
      facts.processes !== undefined ? plural(facts.processes, 'process', 'processes') : undefined,
      facts.runs !== undefined ? plural(facts.runs, 'recorded run') : undefined,
    ].filter((x): x is string => x !== undefined);
    return {
      text:
        known.length === 0
          ? `This workspace has not finished loading, so I cannot count anything yet.${note}`
          : `This workspace holds ${known.join(', ')}.${note}`,
    };
  }
  if (/(graph|inspect|diagram|steps)/.test(q)) {
    return { text: `The graph shows a process's steps in the order XO composed them.${note}`, action: { label: 'Open workflow graph', target: 'graph' } };
  }
  if (/(create|build|new xo|from scratch)/.test(q)) {
    return { text: `You can build an XO from your documents step by step.${note}`, action: { label: 'Create an XO', target: 'create' } };
  }
  const base = scriptedReply(input);
  return note === '' ? base : { ...base, text: `${base.text}${note}` };
}

/** `@bur` -> the XO names that start with it (case-insensitive); only when the caret is inside an @-word. */
export function mentionQuery(text: string): string | undefined {
  const m = /(?:^|\s)@([\w.-]*)$/.exec(text);
  return m === null ? undefined : (m[1] ?? '');
}

export function matchXos<T extends { readonly label: string }>(xos: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  return xos.filter((x) => x.label.toLowerCase().includes(q));
}
