/**
 * UW-3c — Markdown to document blocks with a CommonMark parser (markdown-it, GitHub tables and task lists).
 *
 * What the old line classifier got wrong on real Markdown, and this reads correctly: closed ATX headings ("## Lists ##"),
 * lists numbered "1. 1. 1." (positions count up), list items that wrap onto following lines, nested lists, fenced code
 * (whose "# comment" lines are not headings), links and emphasis (the text is kept, the markup and URLs are not), YAML front
 * matter (its `title` is the document's title, the rest is metadata) and HTML comments.
 *
 * Indented code blocks are switched off: in documents written as plain text an indented paragraph is prose, not code.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { BlockSink, type Span, type UnplacedBlock } from './block-sink.js';
import { htmlFragmentBlocks } from './html-blocks.js';

const md = new MarkdownIt({ html: true, linkify: false, typographer: false }).disable('code');

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export interface MarkdownBlocks {
  readonly blocks: UnplacedBlock[];
  readonly title?: string;
}

function frontMatterTitle(yaml: string): string | undefined {
  const m = /^title:\s*(.+?)\s*$/m.exec(yaml);
  if (m === null) return undefined;
  return m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim() || undefined;
}

/** Inline children to text spans: links keep their text, images their alt text, HTML tags are dropped. */
function spansOf(inline: Token | undefined): Span[] {
  const spans: Span[] = [];
  let bold = 0;
  for (const t of inline?.children ?? []) {
    switch (t.type) {
      case 'strong_open':
        bold += 1;
        break;
      case 'strong_close':
        bold = Math.max(0, bold - 1);
        break;
      case 'text':
      case 'code_inline':
        spans.push({ text: t.content, ...(bold > 0 ? { bold: true } : {}) });
        break;
      case 'softbreak':
      case 'hardbreak':
        spans.push({ text: ' ', ...(bold > 0 ? { bold: true } : {}) });
        break;
      case 'image':
        if (t.content.length > 0) spans.push({ text: t.content });
        break;
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(t.content)) spans.push({ text: ' ' });
        break;
      default:
        break;
    }
  }
  return spans;
}

interface ListFrame {
  readonly ordered: boolean;
  next: number;
}

interface PendingItem {
  readonly ordered: boolean;
  readonly ordinal: number;
  readonly depth: number;
  spans: Span[];
  emitted: boolean;
}

export function markdownBlocks(source: string): MarkdownBlocks {
  let text = source;
  let title: string | undefined;
  const fm = FRONT_MATTER.exec(text);
  if (fm !== null) {
    title = frontMatterTitle(fm[1]!);
    text = text.slice(fm[0].length);
  }
  const sink = new BlockSink();
  if (title !== undefined) sink.heading(1, title);
  const tokens = md.parse(text, {});
  const lists: ListFrame[] = [];
  const items: PendingItem[] = [];
  let table: { rows: string[][]; row: string[] } | undefined;

  const flushItem = (item: PendingItem | undefined): void => {
    if (item === undefined || item.emitted) return;
    item.emitted = true;
    sink.listItem({ ordered: item.ordered, ...(item.ordered ? { ordinal: item.ordinal } : {}), depth: item.depth, spans: item.spans });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'heading_open':
        flushItem(items[items.length - 1]);
        sink.heading(Number(t.tag.slice(1)), spansOf(tokens[i + 1]));
        i += 2;
        break;
      case 'bullet_list_open':
      case 'ordered_list_open':
        flushItem(items[items.length - 1]);
        lists.push({ ordered: t.type === 'ordered_list_open', next: t.type === 'ordered_list_open' ? Number(t.attrGet('start') ?? 1) : 1 });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const frame = lists[lists.length - 1]!;
        items.push({ ordered: frame.ordered, ordinal: frame.next, depth: lists.length - 1, spans: [], emitted: false });
        frame.next += 1;
        break;
      }
      case 'list_item_close':
        flushItem(items.pop());
        break;
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const item = items[items.length - 1];
        if (table === undefined && item !== undefined && !item.emitted) {
          // An item's paragraphs are the item's text (a loose list item can have several).
          if (item.spans.length > 0) item.spans.push({ text: ' ' });
          item.spans.push(...spansOf(inline));
        } else sink.paragraph(spansOf(inline));
        i += 2;
        break;
      }
      case 'fence':
        flushItem(items[items.length - 1]);
        sink.preformatted(t.content);
        break;
      case 'html_block': {
        flushItem(items[items.length - 1]);
        for (const b of htmlFragmentBlocks(t.content)) sinkPush(sink, b);
        break;
      }
      case 'table_open':
        flushItem(items[items.length - 1]);
        table = { rows: [], row: [] };
        break;
      case 'tr_open':
        if (table !== undefined) table.row = [];
        break;
      case 'th_open':
      case 'td_open':
        if (table !== undefined)
          table.row.push(
            spansOf(tokens[i + 1])
              .map((s) => s.text)
              .join(''),
          );
        break;
      case 'tr_close':
        if (table !== undefined) table.rows.push(table.row);
        break;
      case 'table_close':
        table?.rows.forEach((r, k) => sink.tableRow(r, k === 0));
        table = undefined;
        break;
      default:
        break;
    }
  }
  return { blocks: sink.blocks(), ...(title !== undefined ? { title } : {}) };
}

/** Re-emit an already-built block (from an HTML fragment inside Markdown) through the sink's ordering. */
function sinkPush(sink: BlockSink, b: UnplacedBlock): void {
  switch (b.kind) {
    case 'heading':
      sink.heading(b.level, b.text);
      break;
    case 'paragraph':
      if (b.preformatted === true) sink.preformatted(b.text);
      else sink.paragraph(b.text);
      break;
    case 'list_item':
      sink.listItem({
        ordered: b.listKind === 'ordered',
        ...(b.ordinal !== undefined ? { ordinal: b.ordinal } : {}),
        depth: b.depth ?? 0,
        spans: [{ text: b.text }],
        ...(b.checkbox !== undefined ? { checkbox: b.checkbox } : {}),
      });
      break;
    case 'table_row':
      sink.tableRow(b.cells, b.tableStart === true);
      break;
    case 'footnote':
      sink.footnote(b.text);
      break;
  }
}
