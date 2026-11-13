/**
 * UW-3c — one place where Markdown, HTML and Word documents become document blocks.
 *
 * Each format has a real parser (markdown-it, parse5, a linear Word XML reader); each walks its own tree and reports what
 * the AUTHOR marked up: a heading, a paragraph, a list item with its list type, position and nesting, a check box with its
 * tick state, a table row, a code block. This sink turns those reports into the same blocks the PDF reader produces, so every
 * format reaches the semantic layer with the same structure:
 *
 * - list items carry `listKind`, the ordinal the list gives them (by position: Markdown's "1. 1. 1." and Word's automatic
 *   numbering both count up), and their depth;
 * - a check box at the start of an item (`[ ]`, `[x]`, `☐`, `☒`, an HTML check box) becomes the item's tick state;
 * - a bold run at the start of an item, followed by more text, is the item's title;
 * - a paragraph that is entirely bold, short and not a sentence is a heading one level below the current one (Word and HTML
 *   authors often make headings that way);
 * - template-language tags (`{% ... %}`, `{{ ... }}`) are removed: they are markup, not content;
 * - code is kept as preformatted text, never read as prose.
 *
 * Nothing here interprets what the text says. Text is data.
 */
import type { DocumentBlock } from '../../document/types.js';
import { detectCheckbox } from '../../document/list-marker.js';

/** A block before it is placed on a page (the frontends add synthetic provenance). */
export type UnplacedBlock = DocumentBlock extends infer B ? (B extends DocumentBlock ? Omit<B, 'provenance'> : never) : never;

/** One text span as a parser saw it: the text and whether it was bold. */
export interface Span {
  readonly text: string;
  readonly bold?: boolean;
}

const TEMPLATE_TAG = /\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g;
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** Whitespace collapsed, template tags and invisible characters removed. */
export function cleanText(text: string): string {
  return text.replace(TEMPLATE_TAG, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function joinSpans(spans: readonly Span[]): string {
  return cleanText(spans.map((s) => s.text).join(''));
}

/** The bold lead of an item ("**Never commit secrets.** Keys stay in ..."): bold spans first, then non-bold text after. */
function boldLead(spans: readonly Span[]): { readonly title: string; readonly body: string; readonly lead: string } | undefined {
  const first = spans.findIndex((s) => s.text.trim().length > 0);
  if (first < 0 || spans[first]!.bold !== true) return undefined;
  let k = first;
  while (k < spans.length && (spans[k]!.bold === true || spans[k]!.text.trim().length === 0)) k += 1;
  const lead = cleanText(
    spans
      .slice(first, k)
      .map((s) => s.text)
      .join(''),
  );
  const title = lead.replace(/[:\-–—]\s*$/, '').trim();
  const body = joinSpans(spans.slice(k));
  if (title.length === 0 || body.length === 0) return undefined;
  return { title, body, lead };
}

/**
 * The text of a block with a bold lead keeps the lead marked as `**lead** body`: the same run-in heading markup plain
 * Markdown carries, which the semantic layer and the policy reader use to title a passage ("**E1 Receipts.** An expense ...").
 */
function markedText(spans: readonly Span[], plain: string): string {
  const lead = boldLead(spans);
  return lead !== undefined ? `**${lead.lead}** ${lead.body}` : plain;
}

const isSentence = (text: string): boolean => /[.!?;]["')\]]?$/.test(text);

/** Entirely bold, at most eight words and not a full sentence: an author's heading made by formatting. */
export function isBoldHeading(spans: readonly Span[]): boolean {
  const visible = spans.filter((s) => s.text.trim().length > 0);
  if (visible.length === 0 || visible.some((s) => s.bold !== true)) return false;
  const text = joinSpans(visible);
  return text.length > 0 && text.split(' ').length <= 8 && !isSentence(text);
}

const ROMAN = [
  '',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  'vi',
  'vii',
  'viii',
  'ix',
  'x',
  'xi',
  'xii',
  'xiii',
  'xiv',
  'xv',
  'xvi',
  'xvii',
  'xviii',
  'xix',
  'xx',
];

/** The marker an ordered list shows for position `n` in a given style. */
export function orderedMarker(n: number, style: 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman'): string {
  if (style === 'lower-alpha' || style === 'upper-alpha') {
    let s = '';
    let v = n;
    while (v > 0) {
      v -= 1;
      s = String.fromCharCode(97 + (v % 26)) + s;
      v = Math.floor(v / 26);
    }
    return `${style === 'upper-alpha' ? s.toUpperCase() : s}.`;
  }
  if (style === 'lower-roman' || style === 'upper-roman') {
    const r = ROMAN[n] ?? String(n);
    return `${style === 'upper-roman' ? r.toUpperCase() : r}.`;
  }
  return `${n}.`;
}

export interface ListItemReport {
  readonly ordered: boolean;
  /** The position the list gives the item (1-based), for an ordered list. */
  readonly ordinal?: number;
  readonly marker?: string;
  readonly depth: number;
  readonly spans: readonly Span[];
  /** A check box the parser saw as an element (HTML `<input type=checkbox>`), not as text. */
  readonly checkbox?: 'checked' | 'unchecked';
}

export class BlockSink {
  private readonly out: UnplacedBlock[] = [];
  /** The level of the last heading the source marked as a heading; a bold paragraph sits one level below it. */
  private markedLevel = 0;

  heading(level: number, spans: readonly Span[] | string): void {
    this.push(level, spans);
    this.markedLevel = Math.min(6, Math.max(1, level));
  }

  private push(level: number, spans: readonly Span[] | string): void {
    const text = typeof spans === 'string' ? cleanText(spans) : joinSpans(spans);
    if (text.length === 0) return;
    this.out.push({ kind: 'heading', level: Math.min(6, Math.max(1, level)), text });
  }

  paragraph(spans: readonly Span[] | string): void {
    if (typeof spans !== 'string' && isBoldHeading(spans)) {
      this.push(this.markedLevel + 1, spans);
      return;
    }
    const plain = typeof spans === 'string' ? cleanText(spans) : joinSpans(spans);
    if (plain.length === 0) return;
    this.out.push({ kind: 'paragraph', text: typeof spans === 'string' ? plain : markedText(spans, plain) });
  }

  /** Code, a command listing or a file's contents: kept, line breaks normalised, never read as prose. */
  preformatted(text: string): void {
    const body = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    if (body.trim().length === 0) return;
    this.out.push({ kind: 'paragraph', text: body, preformatted: true });
  }

  listItem(item: ListItemReport): void {
    let spans = item.spans;
    const raw = joinSpans(spans);
    let checkbox = item.checkbox;
    let text = raw;
    if (checkbox === undefined) {
      const box = detectCheckbox(raw);
      if (box !== undefined) {
        checkbox = box.state;
        text = cleanText(box.remainder);
        // The box was the item's first characters: drop them from the spans too, so a bold title after it is still seen.
        let drop = box.token.length;
        const rest: Span[] = [];
        for (const s of spans) {
          if (drop <= 0) {
            rest.push(s);
            continue;
          }
          const t = s.text.replace(/^\s+/, '');
          if (t.length <= drop) {
            drop -= t.length;
            continue;
          }
          rest.push({ ...s, text: t.slice(drop) });
          drop = 0;
        }
        spans = rest;
      }
    }
    if (text.length === 0) return;
    // Only a title the author set apart (bold) counts: a short first sentence is usually just the first instruction.
    const titled = boldLead(spans);
    const ordered = item.ordered && checkbox === undefined;
    this.out.push({
      kind: 'list_item',
      marker:
        checkbox !== undefined ? (checkbox === 'checked' ? '[x]' : '[ ]') : (item.marker ?? (item.ordered ? `${item.ordinal ?? 1}.` : '-')),
      listKind: ordered ? 'ordered' : 'unordered',
      text: markedText(spans, text),
      depth: item.depth,
      ...(checkbox !== undefined ? { checkbox } : {}),
      ...(ordered && item.ordinal !== undefined ? { ordinal: item.ordinal } : {}),
      ...(titled !== undefined ? { title: titled.title, body: titled.body } : {}),
    });
  }

  /** One table row. `start` marks a table's first row, so adjacent tables never merge. */
  tableRow(cells: readonly string[], start: boolean): void {
    const clean = cells.map(cleanText);
    if (clean.every((c) => c.length === 0)) return;
    this.out.push({ kind: 'table_row', cells: clean, ...(start ? { tableStart: true as const } : {}) });
  }

  footnote(text: string): void {
    const t = cleanText(text);
    if (t.length > 0) this.out.push({ kind: 'footnote', text: t });
  }

  get length(): number {
    return this.out.length;
  }

  blocks(): UnplacedBlock[] {
    return [...this.out];
  }
}
