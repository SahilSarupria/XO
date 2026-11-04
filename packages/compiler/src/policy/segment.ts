import { leadingRunInHeading } from '../semantic/title.js';

/**
 * One self-contained passage of a policy/procedure document: a paragraph with its governing section and its own
 * title (a bold run-in heading `**Title.** body` when the author gave one, otherwise the section heading).
 */
export interface PolicyEntry {
  readonly id: string;
  readonly index: number;
  readonly section: string;
  readonly title: string;
  readonly text: string;
  readonly sentences: readonly string[];
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'entry';

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'no.', 'inc.', 'ltd.', 'st.', 'dr.', 'mr.', 'ms.'];

/** Sentence splitter that does not split inside decimals ("$2.50"), common abbreviations, or "(1) a, (2) b" lists. */
export function splitPolicySentences(text: string): string[] {
  const protectedText = ABBREVIATIONS.reduce((acc, a) => acc.split(a).join(a.replace(/\./g, '\u0001')), text.replace(/\s+/g, ' ').trim());
  const out: string[] = [];
  let start = 0;
  const re = /[.!?](?=\s+(?:[A-Z"“(]|\d+[.)]\s))/g;
  for (let m = re.exec(protectedText); m !== null; m = re.exec(protectedText)) {
    const end = m.index + 1;
    out.push(protectedText.slice(start, end));
    start = end;
  }
  out.push(protectedText.slice(start));
  return out.map((s) => s.replace(/\u0001/g, '.').trim()).filter((s) => s.length > 0);
}

/** Splits a Markdown policy document into entries. Heading lines (#, ##, ###) set the section; blank lines separate paragraphs. */
export function segmentPolicyText(markdown: string): PolicyEntry[] {
  const entries: PolicyEntry[] = [];
  const used = new Map<string, number>();
  let docTitle = '';
  let section = '';
  let para: string[] = [];

  const flush = (): void => {
    const raw = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    if (raw.length === 0) return;
    const runIn = leadingRunInHeading(raw);
    let title: string;
    let body: string;
    if (runIn !== undefined) {
      title = runIn;
      body = raw.replace(/^(\*\*|__)[\s\S]*?\1[.:;,]?\s*/u, '').trim();
      if (body.length === 0) body = runIn;
    } else {
      title = section.length > 0 ? section : docTitle;
      body = raw;
    }
    const base = slug(title);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    entries.push({
      id: n === 1 ? base : `${base}_${n}`,
      index: entries.length,
      section: section.length > 0 ? section : docTitle,
      title,
      text: body,
      sentences: splitPolicySentences(body),
    });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h !== null) {
      flush();
      const text = (h[2] as string).replace(/[*_`]/g, '').trim();
      if ((h[1] as string).length === 1 && docTitle === '') docTitle = text;
      else section = text;
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  flush();
  return entries;
}
