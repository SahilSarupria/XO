/**
 * UW-3c — HTML to document blocks with the WHATWG parser (parse5), the same parse a browser does.
 *
 * The old frontend matched `<h1>`, `<p>` and `<li>` with regular expressions: it dropped tables, code, text in `<div>`s and
 * check boxes, could not tell an ordered list from a bulleted one, and flattened nested lists into their parent. This walks
 * the parsed tree instead:
 *
 * - the main content is read (`<main>`, or a single `<article>`, else `<body>`); site chrome (`<nav>`, `<aside>`, a page
 *   `<header>`/`<footer>` outside the content) and non-content (`<script>`, `<style>`, `<template>`, hidden elements) is not;
 * - `<ol>`/`<ul>` give list type, `start` and `type` give positions, nesting gives depth, and an `<input type=checkbox>` in an
 *   item gives its tick state;
 * - a `<table>` with two or more columns gives table rows (the first row starts the table); a one-column table is a layout
 *   box, and its contents are read as ordinary blocks;
 * - `<pre>` is preformatted text; text directly inside a container (`<div>`, `<td>`) is a paragraph.
 */
import { parse, parseFragment } from 'parse5';
import { BlockSink, type Span, type UnplacedBlock } from './block-sink.js';

interface Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly Node[];
  readonly content?: Node;
}

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'head',
  'select',
  'textarea',
  'button',
  'math',
]);
const CHROME = new Set(['nav', 'aside']);
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
  'caption',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'body',
  'html',
  'legend',
]);

const tag = (n: Node): string => (n.tagName ?? '').toLowerCase();
const attr = (n: Node, name: string): string | undefined => n.attrs?.find((a) => a.name === name)?.value;
const isElement = (n: Node): boolean => n.tagName !== undefined;

function hidden(n: Node): boolean {
  if (!isElement(n)) return false;
  if (attr(n, 'hidden') !== undefined || attr(n, 'aria-hidden') === 'true') return true;
  const style = (attr(n, 'style') ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function boldStyle(n: Node): boolean {
  const t = tag(n);
  if (t === 'b' || t === 'strong') return true;
  const style = (attr(n, 'style') ?? '').replace(/\s+/g, '').toLowerCase();
  return /font-weight:(?:bold|[6-9]00)/.test(style);
}

function textContent(n: Node): string {
  if (n.nodeName === '#text') return n.value ?? '';
  if (!isElement(n) || SKIP.has(tag(n))) return '';
  if (tag(n) === 'br') return '\n';
  return (n.childNodes ?? []).map(textContent).join('');
}

/** Inline spans of `n`'s inline content; block descendants contribute their text too, separated by a space. */
function inlineSpans(n: Node, bold = false, out: Span[] = []): Span[] {
  for (const c of n.childNodes ?? []) {
    if (c.nodeName === '#text') {
      out.push({ text: c.value ?? '', ...(bold ? { bold: true } : {}) });
      continue;
    }
    if (!isElement(c) || SKIP.has(tag(c)) || hidden(c)) continue;
    const t = tag(c);
    if (t === 'br') {
      out.push({ text: ' ' });
      continue;
    }
    if (t === 'img' || t === 'input') continue;
    if (BLOCK.has(t)) out.push({ text: ' ' });
    inlineSpans(c, bold || boldStyle(c), out);
    if (BLOCK.has(t)) out.push({ text: ' ' });
  }
  return out;
}

type ListStyle = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

function listStyle(n: Node): ListStyle {
  const type = attr(n, 'type');
  if (type === 'a') return 'lower-alpha';
  if (type === 'A') return 'upper-alpha';
  if (type === 'i') return 'lower-roman';
  if (type === 'I') return 'upper-roman';
  return 'decimal';
}

class Walker {
  constructor(readonly sink: BlockSink) {}

  /** Children of a block container: runs of inline content become paragraphs; block children are walked. */
  container(n: Node, depth: number): void {
    let inline: Span[] = [];
    const flush = (): void => {
      if (inline.some((s) => s.text.trim().length > 0)) this.sink.paragraph(inline);
      inline = [];
    };
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === '#text') {
        inline.push({ text: c.value ?? '' });
        continue;
      }
      if (!isElement(c) || SKIP.has(tag(c)) || hidden(c)) continue;
      const t = tag(c);
      if (t === 'br') {
        flush();
        continue;
      }
      if (!BLOCK.has(t)) {
        if (t === 'img' || t === 'input') continue;
        inline.push(...inlineSpans({ ...c, childNodes: [c] }, false));
        continue;
      }
      flush();
      this.block(c, depth);
    }
    flush();
  }

  block(n: Node, depth: number): void {
    const t = tag(n);
    if (CHROME.has(t)) return;
    if (/^h[1-6]$/.test(t)) {
      this.sink.heading(
        Number(t[1]),
        inlineSpans(n, true).map((s) => ({ text: s.text })),
      );
      return;
    }
    if (t === 'p' || t === 'dt' || t === 'dd' || t === 'summary' || t === 'caption' || t === 'figcaption' || t === 'legend') {
      // A paragraph can still hold a block (an author's <p><div>..</div></p> is reparsed, but <p> with <table> inside a <dd> is not).
      const hasBlock = (n.childNodes ?? []).some((c) => isElement(c) && BLOCK.has(tag(c)) && tag(c) !== 'br');
      if (hasBlock) this.container(n, depth);
      else this.sink.paragraph(inlineSpans(n, boldStyle(n)));
      return;
    }
    if (t === 'pre') {
      this.sink.preformatted(textContent(n));
      return;
    }
    if (t === 'ul' || t === 'ol') {
      this.list(n, depth);
      return;
    }
    if (t === 'table') {
      this.table(n, depth);
      return;
    }
    if (t === 'hr') return;
    if (t === 'li') {
      // An item outside a list (broken markup): read it as an unordered item.
      this.item(n, { ordered: false, depth, ordinal: undefined, style: 'decimal' });
      return;
    }
    this.container(n, depth);
  }

  list(n: Node, depth: number): void {
    const ordered = tag(n) === 'ol';
    const style = listStyle(n);
    let next = ordered ? Number(attr(n, 'start') ?? '1') || 1 : 1;
    const reversed = ordered && attr(n, 'reversed') !== undefined;
    for (const c of n.childNodes ?? []) {
      if (!isElement(c) || hidden(c)) continue;
      if (tag(c) === 'li') {
        const value = attr(c, 'value');
        if (value !== undefined && Number.isFinite(Number(value))) next = Number(value);
        this.item(c, { ordered, depth, ordinal: ordered ? next : undefined, style });
        next += reversed ? -1 : 1;
      } else if (tag(c) === 'ul' || tag(c) === 'ol') {
        this.list(c, depth + 1);
      } else if (!SKIP.has(tag(c))) this.block(c, depth);
    }
  }

  item(n: Node, at: { ordered: boolean; depth: number; ordinal: number | undefined; style: ListStyle }): void {
    const spans: Span[] = [];
    const after: Node[] = [];
    let checkbox: 'checked' | 'unchecked' | undefined;
    const visit = (parent: Node, bold: boolean): void => {
      for (const c of parent.childNodes ?? []) {
        if (c.nodeName === '#text') {
          spans.push({ text: c.value ?? '', ...(bold ? { bold: true } : {}) });
          continue;
        }
        if (!isElement(c) || SKIP.has(tag(c)) || hidden(c)) continue;
        const t = tag(c);
        if (t === 'input' && (attr(c, 'type') ?? '').toLowerCase() === 'checkbox') {
          if (checkbox === undefined) checkbox = attr(c, 'checked') !== undefined ? 'checked' : 'unchecked';
          continue;
        }
        if (t === 'ul' || t === 'ol' || t === 'table' || t === 'pre') {
          after.push(c);
          continue;
        }
        if (t === 'br') {
          spans.push({ text: ' ' });
          continue;
        }
        if (BLOCK.has(t)) {
          spans.push({ text: ' ' });
          visit(c, bold || boldStyle(c));
          spans.push({ text: ' ' });
          continue;
        }
        visit(c, bold || boldStyle(c));
      }
    };
    visit(n, false);
    this.sink.listItem({
      ordered: at.ordered,
      ...(at.ordinal !== undefined ? { ordinal: at.ordinal } : {}),
      depth: at.depth,
      spans,
      ...(checkbox !== undefined ? { checkbox } : {}),
    });
    for (const c of after) {
      if (tag(c) === 'ul' || tag(c) === 'ol') this.list(c, at.depth + 1);
      else this.block(c, at.depth + 1);
    }
  }

  table(n: Node, depth: number): void {
    const rows: Node[] = [];
    const collect = (p: Node): void => {
      for (const c of p.childNodes ?? []) {
        if (!isElement(c) || hidden(c)) continue;
        const t = tag(c);
        if (t === 'tr') rows.push(c);
        else if (t === 'thead' || t === 'tbody' || t === 'tfoot') collect(c);
      }
    };
    collect(n);
    const cellsOf = (r: Node): Node[] => (r.childNodes ?? []).filter((c) => isElement(c) && (tag(c) === 'td' || tag(c) === 'th'));
    const width = Math.max(0, ...rows.map((r) => cellsOf(r).reduce((w, c) => w + (Number(attr(c, 'colspan') ?? '1') || 1), 0)));
    if (width <= 1) {
      // A one-column table is a box around content, not data.
      for (const r of rows) for (const c of cellsOf(r)) this.container(c, depth);
      return;
    }
    rows.forEach((r, k) => {
      const cells = cellsOf(r).map((c) =>
        inlineSpans(c)
          .map((s) => s.text)
          .join(''),
      );
      this.sink.tableRow(cells, k === 0);
    });
  }
}

function findFirst(n: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(n)) return n;
  for (const c of n.childNodes ?? []) {
    const f = findFirst(c, pred);
    if (f !== undefined) return f;
  }
  return undefined;
}

function findAll(n: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (pred(n)) out.push(n);
  for (const c of n.childNodes ?? []) findAll(c, pred, out);
  return out;
}

export interface HtmlBlocks {
  readonly blocks: UnplacedBlock[];
  readonly title?: string;
}

/** A whole HTML document: its main content as blocks, and its `<title>`. */
export function htmlDocumentBlocks(html: string): HtmlBlocks {
  const doc = parse(html) as unknown as Node;
  const titleNode = findFirst(doc, (n) => tag(n) === 'title');
  const title = titleNode !== undefined ? textContent(titleNode).replace(/\s+/g, ' ').trim() : undefined;
  const body = findFirst(doc, (n) => tag(n) === 'body') ?? doc;
  const main = findFirst(body, (n) => tag(n) === 'main' || attr(n, 'role') === 'main');
  const articles = findAll(body, (n) => tag(n) === 'article');
  const root = main ?? (articles.length === 1 ? articles[0]! : body);
  const sink = new BlockSink();
  const walker = new Walker(sink);
  if (root === body) {
    // Site chrome around the content: a page footer, or a page header with navigation, directly in <body>. A header that
    // holds the page's title heading (a title block) is content.
    const chrome = (c: Node): boolean =>
      tag(c) === 'footer' ||
      (tag(c) === 'header' &&
        (findFirst(c, (n) => tag(n) === 'nav') !== undefined || findFirst(c, (n) => /^h[1-6]$/.test(tag(n))) === undefined));
    walker.container({ ...body, childNodes: (body.childNodes ?? []).filter((c) => !chrome(c)) }, 0);
  } else walker.container(root, 0);
  return { blocks: sink.blocks(), ...(title !== undefined && title.length > 0 ? { title } : {}) };
}

/** An HTML fragment (embedded in Markdown, say) as blocks. Comments and non-content produce nothing. */
export function htmlFragmentBlocks(html: string): UnplacedBlock[] {
  const frag = parseFragment(html) as unknown as Node;
  const sink = new BlockSink();
  new Walker(sink).container(frag, 0);
  return sink.blocks();
}
