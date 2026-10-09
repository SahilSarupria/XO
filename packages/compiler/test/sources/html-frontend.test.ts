import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HtmlSourceFrontend } from '../../src/sources/html-frontend.js';

const frontend = new HtmlSourceFrontend();

const FIXTURE_HTML = `
<!doctype html>
<html>
  <head><title>Confidentiality Overview</title><style>.x{color:red}</style></head>
  <body>
    <script>var shouldBeIgnored = "<p>not real content</p>";</script>
    <h1>Confidentiality Overview</h1>
    <p>This page explains the <b>confidentiality</b> obligations &amp; scope.</p>
    <h2>Exceptions</h2>
    <ul>
      <li>Publicly available information</li>
      <li>Independently developed information</li>
    </ul>
  </body>
</html>
`;

test('canHandle accepts tagged html input only', () => {
  assert.equal(frontend.canHandle({ kind: 'html', html: '<p>x</p>', sourcePath: 'a.html' }), true);
  assert.equal(frontend.canHandle({ kind: 'document', text: 'x', sourcePath: 'a.txt' }), false);
});

test('extracts title, headings, paragraphs, and list items in document order, decoding entities and stripping inner tags', () => {
  const result = frontend.ingest({ kind: 'html', html: FIXTURE_HTML, sourcePath: 'overview.html', url: 'https://example.com/overview' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sourceType, 'html');
  assert.equal(result.value.semanticExtractionAvailable, true);
  assert.equal(result.value.metadata.url, 'https://example.com/overview');
  assert.equal(result.value.content.kind, 'document');
  if (result.value.content.kind !== 'document') return;

  assert.equal(result.value.content.documentTitle, 'Confidentiality Overview');

  const root = result.value.content.parsed.root;
  assert.equal(root.subsections.length, 1);
  const h1 = root.subsections[0]!;
  assert.equal(h1.heading?.text, 'Confidentiality Overview');
  assert.equal(h1.heading?.level, 1);
  assert.equal(h1.blocks.length, 1);
  assert.equal(h1.blocks[0]!.kind, 'paragraph');
  if (h1.blocks[0]!.kind === 'paragraph') {
    assert.match(h1.blocks[0].text, /confidentiality obligations & scope/);
    assert.doesNotMatch(h1.blocks[0].text, /<b>/);
  }

  assert.equal(h1.subsections.length, 1);
  const exceptions = h1.subsections[0]!;
  assert.equal(exceptions.heading?.text, 'Exceptions');
  assert.equal(exceptions.blocks.length, 2);
  assert.deepEqual(
    exceptions.blocks.map((b) => b.kind),
    ['list_item', 'list_item'],
  );
});

test('script/style content is never mistaken for page content', () => {
  const result = frontend.ingest({ kind: 'html', html: FIXTURE_HTML, sourcePath: 'overview.html' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  assert.doesNotMatch(result.value.content.plainText, /not real content/);
});

test('HTML with no recognizable block content fails with SOURCE_PARSE_FAILED', () => {
  const result = frontend.ingest({ kind: 'html', html: '<div><span>just inline stuff</span></div>', sourcePath: 'empty.html' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_PARSE_FAILED');
});

test('empty HTML string fails with SOURCE_CONTENT_UNAVAILABLE', () => {
  const result = frontend.ingest({ kind: 'html', html: '   ', sourcePath: 'blank.html' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PRECONDITION_FAILED');
});

test('ingest is deterministic (no network, pure fixture parsing)', () => {
  const input = { kind: 'html' as const, html: FIXTURE_HTML, sourcePath: 'overview.html' };
  const a = frontend.ingest(input);
  const b = frontend.ingest(input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.deepEqual(a.value, b.value);
});
