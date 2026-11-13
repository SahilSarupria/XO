/**
 * UW-3c — Markdown, HTML and Word reach the semantic layer with the structure their authors marked up: list type,
 * position and nesting, tick state, bold run-in titles, tables, headings, and code kept apart from prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownBlocks } from '../../src/sources/structured-blocks/markdown-blocks.js';
import { htmlDocumentBlocks, htmlFragmentBlocks } from '../../src/sources/structured-blocks/html-blocks.js';
import { docxBlocks } from '../../src/sources/structured-blocks/docx-blocks.js';
import { BlockSink, cleanText, orderedMarker, type UnplacedBlock } from '../../src/sources/structured-blocks/block-sink.js';
import { readDocx } from '../../src/sources/docx-text.js';
import { zip } from './zip-builder.js';

type Item = UnplacedBlock & { kind: 'list_item' };
const items = (blocks: readonly UnplacedBlock[]): Item[] => blocks.filter((b): b is Item => b.kind === 'list_item');
const brief = (b: UnplacedBlock): string =>
  b.kind === 'list_item'
    ? `${b.listKind === 'ordered' ? b.ordinal : '-'}@${b.depth ?? 0}${b.checkbox !== undefined ? `[${b.checkbox}]` : ''} ${b.text}`
    : b.kind === 'heading'
      ? `h${b.level} ${b.text}`
      : b.kind === 'table_row'
        ? `| ${b.cells.join(' | ')}${b.tableStart === true ? ' (start)' : ''}`
        : `${b.kind === 'paragraph' && b.preformatted === true ? 'pre' : b.kind}: ${b.text}`;

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('Markdown: closed headings, "1. 1. 1." lists, wrapped and nested items, task lists, code and front matter', () => {
  const md = [
    '---',
    'title: Branch protection',
    'layout: page',
    '---',
    '',
    '## Steps ##',
    '',
    '1. Add the skeleton as a remote',
    '   to the repository.',
    '1. Pull with `--allow-unrelated-histories`.',
    '   - Note: this will conflict.',
    '1. Fix the conflicts.',
    '',
    '```console',
    '# Create a new branch',
    'git checkout -b skeletonize',
    '```',
    '',
    '- [x] Require pull request reviews',
    '- [ ] Allow force pushes',
    '',
    'See [the guide](https://example.gov/guide) for **details**. <!-- a comment -->',
  ].join('\n');
  const r = markdownBlocks(md);
  assert.equal(r.title, 'Branch protection');
  assert.deepEqual(r.blocks.map(brief), [
    'h1 Branch protection',
    'h2 Steps',
    '1@0 Add the skeleton as a remote to the repository.',
    '2@0 Pull with --allow-unrelated-histories.',
    '-@1 Note: this will conflict.',
    '3@0 Fix the conflicts.',
    'pre: # Create a new branch\ngit checkout -b skeletonize',
    '-@0[checked] Require pull request reviews',
    '-@0[unchecked] Allow force pushes',
    'paragraph: See the guide for details.',
  ]);
});

test('Markdown: a bold run-in title is the item title and stays marked in the text; a GitHub table keeps its rows', () => {
  const r = markdownBlocks('- **Never commit secrets.** Keys stay in the vault.\n\n| Step | Owner |\n| --- | --- |\n| Build | Dev |\n');
  const [item] = items(r.blocks);
  assert.equal(item!.title, 'Never commit secrets.');
  assert.equal(item!.body, 'Keys stay in the vault.');
  assert.equal(item!.text, '**Never commit secrets.** Keys stay in the vault.');
  assert.deepEqual(r.blocks.filter((b) => b.kind === 'table_row').map(brief), ['| Step | Owner (start)', '| Build | Dev']);
});

test('Markdown: indented text is prose, not code (plain-text documents indent paragraphs)', () => {
  const r = markdownBlocks('Intro.\n\n    The insured must notify the insurer.\n');
  assert.deepEqual(r.blocks.map(brief), ['paragraph: Intro.', 'paragraph: The insured must notify the insurer.']);
});

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('HTML: main content only, ordered lists with start, nesting, check boxes, tables and div text', () => {
  const html = `<!doctype html><html><head><title>Onboarding</title><style>p{}</style></head><body>
    <header><nav><a href="/">Home</a></nav></header>
    <main>
      <h1>Onboarding</h1>
      <div>Welcome to the team.</div>
      <ol start="3"><li>Create the issue<ol type="a"><li>Name it</li></ol></li><li>Assign a buddy</li></ol>
      <ul class="task-list"><li><input type="checkbox" checked disabled> Meet your buddy</li><li><input type="checkbox"> Join the chat</li></ul>
      <table><thead><tr><th>Ritual</th><th>Day</th></tr></thead><tbody><tr><td>Standup</td><td>Daily</td></tr></tbody></table>
      <table><tr><td><p>A callout box.</p></td></tr></table>
      <pre><code>npm test</code></pre>
      <p hidden>Not shown.</p>
    </main>
    <footer>Contact us</footer></body></html>`;
  const r = htmlDocumentBlocks(html);
  assert.equal(r.title, 'Onboarding');
  assert.deepEqual(r.blocks.map(brief), [
    'h1 Onboarding',
    'paragraph: Welcome to the team.',
    '3@0 Create the issue',
    '1@1 Name it',
    '4@0 Assign a buddy',
    '-@0[checked] Meet your buddy',
    '-@0[unchecked] Join the chat',
    '| Ritual | Day (start)',
    '| Standup | Daily',
    'paragraph: A callout box.',
    'pre: npm test',
  ]);
});

test('HTML: a page header holding the title heading is content; one with navigation is chrome', () => {
  const titled = htmlDocumentBlocks('<body><header><h1>Use data to drive decisions</h1></header><p>Measure it.</p></body>');
  assert.deepEqual(titled.blocks.map(brief), ['h1 Use data to drive decisions', 'paragraph: Measure it.']);
  const chrome = htmlDocumentBlocks('<body><header><nav>Menu</nav><h2>Site</h2></header><p>Body.</p></body>');
  assert.deepEqual(chrome.blocks.map(brief), ['paragraph: Body.']);
});

test('HTML: a Word export (<ol><li><p>) and a bold-only paragraph read as a list and a heading', () => {
  const r = htmlFragmentBlocks(
    '<h2>Checklist</h2><p><b>Risks</b></p><ol><li><p style="margin:0">Ship a functioning MVP</p></li><li><p>Run tests</p></li></ol>',
  );
  assert.deepEqual(r.map(brief), ['h2 Checklist', 'h3 Risks', '1@0 Ship a functioning MVP', '2@0 Run tests']);
});

// ── Word ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, opts: { style?: string; num?: [numId: string, ilvl: number]; bold?: boolean } = {}): string =>
  `<w:p><w:pPr>${opts.style !== undefined ? `<w:pStyle w:val="${opts.style}"/>` : ''}${
    opts.num !== undefined ? `<w:numPr><w:ilvl w:val="${opts.num[1]}"/><w:numId w:val="${opts.num[0]}"/></w:numPr>` : ''
  }</w:pPr><w:r>${opts.bold === true ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

test('Word: numbering.xml gives numbered vs bulleted, Word positions, nesting, continuation and restarts', () => {
  const body = [
    para('How to use', { style: 'Heading2' }),
    para('Fill the list.', { num: ['1', 0] }),
    para('Plan the day.', { num: ['1', 0] }),
    para('Focus on outcomes.', { num: ['1', 1] }),
    para('Consider the audience.', { num: ['1', 1] }),
    para('Paste the ship.', { num: ['1', 0] }),
    para('A bullet.', { num: ['2', 0] }),
    para('Restarted list.', { num: ['3', 0] }),
  ].join('');
  const r = docxBlocks({ document: `<w:document ${W}><w:body>${body}</w:body></w:document>`, numbering: NUMBERING });
  assert.deepEqual(r.blocks.map(brief), [
    'h2 How to use',
    '1@0 Fill the list.',
    '2@0 Plan the day.',
    '1@1 Focus on outcomes.',
    '2@1 Consider the audience.',
    '3@0 Paste the ship.',
    '-@0 A bullet.',
    '1@0 Restarted list.',
  ]);
  assert.equal(items(r.blocks)[2]!.marker, 'a.');
  assert.deepEqual(r.notes, []);
});

test('Word: a one-cell table is a callout box; a data table keeps rows; check-box glyphs and bold leads are read', () => {
  const cell = (inner: string): string => `<w:tc>${inner}</w:tc>`;
  const box = `<w:tbl><w:tr>${cell(para('FRONT MATTER') + para('Teams are expected to ship weekly.'))}</w:tr></w:tbl>`;
  const data = `<w:tbl><w:tr>${cell(para('Name'))}${cell(para('Role'))}</w:tr><w:tr>${cell(para('Ada'))}${cell(para('Lead'))}</w:tr></w:tbl>`;
  const boxed = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r><w:r><w:t xml:space="preserve">Reviewed</w:t></w:r></w:p>`;
  const lead = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">E1 Receipts. </w:t></w:r><w:r><w:t>A receipt is required.</w:t></w:r></w:p>`;
  const r = docxBlocks({
    document: `<w:document ${W}><w:body>${box}${data}${boxed}${lead}${para('Progress', { bold: true })}</w:body></w:document>`,
    numbering: NUMBERING,
  });
  assert.deepEqual(r.blocks.map(brief), [
    'paragraph: FRONT MATTER',
    'paragraph: Teams are expected to ship weekly.',
    '| Name | Role (start)',
    '| Ada | Lead',
    '-@0[checked] Reviewed',
    'paragraph: **E1 Receipts.** A receipt is required.',
    'h1 Progress',
  ]);
});

test('Word: deleted text, field codes and fallback copies are not read; missing numbering is disclosed', () => {
  const body =
    `<w:p><w:r><w:t>Kept </w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK x</w:instrText></w:r><w:r><w:t>text.</w:t></w:r></w:p>` +
    `<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>Box</w:t></mc:Choice><mc:Fallback><w:t>Box</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>` +
    para('Numbered without definitions.', { num: ['9', 0] });
  const r = docxBlocks({ document: `<w:document ${W}><w:body>${body}</w:body></w:document>` });
  assert.deepEqual(r.blocks.map(brief), ['paragraph: Kept text.', 'paragraph: Box', '-@0 Numbered without definitions.']);
  assert.ok(r.notes.some((n) => /numbering/.test(n)));
});

test('Word: the reader is linear — 40,000 unterminated tags read in well under a second', () => {
  const evil = `<w:document ${W}><w:body><w:p><w:r>${'<w:t>x'.repeat(40_000)}</w:r></w:p></w:body></w:document>`;
  const started = performance.now();
  docxBlocks({ document: evil });
  assert.ok(performance.now() - started < 1000);
});

test('Word: readDocx reads footnotes as notes and refuses a document without word/document.xml', () => {
  const fn = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Applies to contractors.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const ok = readDocx(
    zip([
      { name: 'word/document.xml', data: `<w:document ${W}><w:body>${para('Main text.')}</w:body></w:document>` },
      { name: 'word/footnotes.xml', data: fn },
    ]),
  );
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.value.blocks.map(brief), ['paragraph: Main text.', 'footnote: Applies to contractors.']);
  const bad = readDocx(zip([{ name: 'word/other.xml', data: '<x/>' }]));
  assert.ok(!bad.ok && /word\/document\.xml is missing/.test(bad.error.message));
});

// ── the sink ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the sink: template tags and invisible characters are removed; markers count in every list style', () => {
  assert.equal(cleanText('Go to {% page "/leave/" %} the​ page {{ site.url }}.'), 'Go to the page .');
  assert.deepEqual(
    [orderedMarker(3, 'decimal'), orderedMarker(2, 'lower-alpha'), orderedMarker(28, 'upper-alpha'), orderedMarker(4, 'lower-roman')],
    ['3.', 'b.', 'AB.', 'iv.'],
  );
  const sink = new BlockSink();
  sink.paragraph([{ text: 'All repositories should be public.', bold: true }]);
  sink.paragraph([{ text: 'Leadership decisions needed', bold: true }]);
  assert.deepEqual(sink.blocks().map(brief), ['paragraph: All repositories should be public.', 'h1 Leadership decisions needed']);
});
