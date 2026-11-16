/**
 * UW-3b — layout recovery: tables whose cells wrap, marker-led lists, checklists and fill-in forms, read from geometry.
 * Each detector is all-or-nothing and conservative; the negative cases below are the ones that keep prose and existing
 * tables exactly as they were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBlocks, detectWrappedTables } from '../../src/document/block-builder.js';
import { classifyLines, detectStructuralListLines, type ClassifiedLine } from '../../src/document/block-classifier.js';
import type { Line } from '../../src/document/line-grouper.js';
import { detectCheckbox, detectListMarker, detectStandaloneMarker, markerOrdinal, splitTitleBody } from '../../src/document/list-marker.js';
import { buildFontEncodingResolver } from '../../src/pdf/font-encoding.js';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import type { DocumentBlock, DocumentSection } from '../../src/document/types.js';

type Cell = readonly [x: number, text: string, font?: string];

function line(cells: readonly Cell[], y: number, page = 1, fontSizePt = 10): Line {
  const runs = cells.map(([x, text, font]) => ({ bytes: Buffer.from(text, 'latin1'), fontName: font, fontSizePt, x, y }));
  return {
    pageNumber: page,
    y,
    minX: cells[0]![0],
    maxFontSizePt: fontSizePt,
    text: cells.map(([, t]) => t.trim()).join(' '),
    runs,
    runTexts: cells.map(([, t]) => t),
  };
}

function classify(lines: readonly Line[], bodySize = 10): readonly ClassifiedLine[] {
  return classifyLines([{ pageNumber: 1, mediaBox: [0, 0, 600, 800], lines }], bodySize, []);
}

function allBlocks(section: DocumentSection): DocumentBlock[] {
  return [...section.blocks, ...section.subsections.flatMap(allBlocks)];
}

// ── markers ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('checkbox markers are list markers with their tick state', () => {
  assert.deepEqual(detectCheckbox('[ ] Branch created'), { token: '[ ]', state: 'unchecked', remainder: 'Branch created' });
  assert.deepEqual(detectCheckbox('☑ Reviewed'), { token: '☑', state: 'checked', remainder: 'Reviewed' });
  assert.equal(detectCheckbox('[note] not a box'), undefined);
  assert.deepEqual(detectListMarker('[x] Tests pass'), {
    marker: '[x]',
    remainder: 'Tests pass',
    listKind: 'unordered',
    checkbox: 'checked',
  });
});

test('a standalone marker token: bare numbers yes, bare letters no (a lone glyph is not a marker)', () => {
  assert.equal(detectStandaloneMarker('1')?.ordinal, 1);
  assert.equal(detectStandaloneMarker('12.')?.ordinal, 12);
  assert.equal(detectStandaloneMarker('c)')?.ordinal, 3);
  assert.equal(detectStandaloneMarker('iv.')?.ordinal, 4);
  assert.equal(detectStandaloneMarker('T'), undefined);
  assert.equal(detectStandaloneMarker('Step'), undefined);
  assert.equal(detectStandaloneMarker('[ ]')?.checkbox, 'unchecked');
  assert.equal(markerOrdinal('•'), undefined);
});

test('a short first sentence is a title only when a body follows it', () => {
  assert.deepEqual(splitTitleBody('Never commit secrets. API keys stay in environment variables.'), {
    title: 'Never commit secrets',
    body: 'API keys stay in environment variables.',
  });
  assert.equal(splitTitleBody('Reproduce the problem with the smallest possible example.'), undefined);
  assert.equal(splitTitleBody('This first sentence is far too long to be a title of anything. Body.'), undefined);
});

// ── marker-led lists ─────────────────────────────────────────────────────────────────────────────────────────────

test('numbered markers in a column of their own become ordered list items, with a bold title split from its body', () => {
  const lines = [
    line(
      [
        [62, '1', 'B'],
        [91, 'One task, one purpose.', 'B'],
        [91, ' Do not mix unrelated changes.', 'R'],
      ],
      700,
    ),
    line(
      [
        [62, '2', 'B'],
        [91, 'Never commit secrets.', 'B'],
        [91, ' Keys stay in environment variables.', 'R'],
      ],
      677,
    ),
  ];
  const blocks = buildBlocks(classify(lines), 10);
  assert.equal(blocks.length, 2);
  const [a, b] = blocks;
  assert.ok(a!.kind === 'list_item' && b!.kind === 'list_item');
  assert.equal(a.ordinal, 1);
  assert.equal(a.listKind, 'ordered');
  assert.equal(a.title, 'One task, one purpose');
  assert.equal(a.body, 'Do not mix unrelated changes.');
  assert.equal(b.title, 'Never commit secrets');
  assert.equal(b.text, 'Never commit secrets. Keys stay in environment variables.');
});

test('a wrapped line in the text column is appended to its item', () => {
  const lines = [
    line(
      [
        [62, '1'],
        [91, 'Read the error message fully; the answer'],
      ],
      700,
    ),
    line([[91, 'is often in it.']], 688),
    line(
      [
        [62, '2'],
        [91, 'Change one thing at a time.'],
      ],
      665,
    ),
  ];
  const blocks = buildBlocks(classify(lines), 10);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0]!.kind === 'list_item');
  assert.equal(blocks[0].text, 'Read the error message fully; the answer is often in it.');
});

test('an isolated "number + text" line is NOT a list item (no sequence, no evidence)', () => {
  const lines = [
    line(
      [
        [48, '4'],
        [99, 'and/or exit points to the Premises proposed for Insurance'],
      ],
      700,
    ),
    line([[99, 'and at internal entry points.']], 690),
  ];
  const structural = detectStructuralListLines(lines, 10);
  assert.equal(structural.items.size, 0);
  assert.ok(buildBlocks(classify(lines), 10).every((b) => b.kind !== 'list_item'));
});

test('markers that do not count up by one are not a list', () => {
  const lines = [
    line(
      [
        [62, '3'],
        [91, 'Alpha text here.'],
      ],
      700,
    ),
    line(
      [
        [62, '7'],
        [91, 'Beta text here.'],
      ],
      677,
    ),
  ];
  assert.equal(detectStructuralListLines(lines, 10).items.size, 0);
});

test('a glyph positioned in its own run (no white space before the text) is not a marker', () => {
  const lines = [
    line(
      [
        [96, '1.'],
        [102, 'ally Prime (Accounting).'],
      ],
      700,
    ),
    line(
      [
        [96, '2.'],
        [102, 'tilizing a system.'],
      ],
      677,
    ),
  ];
  assert.equal(detectStructuralListLines(lines, 10).items.size, 0);
});

test('a marker-led row with several cells is a table row, not a list item', () => {
  const lines = [
    line(
      [
        [62, '1'],
        [88, 'Plan'],
        [160, 'Break the work down.'],
      ],
      700,
    ),
    line(
      [
        [62, '2'],
        [88, 'Build'],
        [160, 'Implement it.'],
      ],
      677,
    ),
  ];
  assert.equal(detectStructuralListLines(lines, 10).items.size, 0);
});

test('a bullet set half a point above body size is a list item, not a heading', () => {
  const lines = [line([[62, '• Reproduce the problem.']], 700, 1, 10.5), line([[62, '• Read the error message.']], 686, 1, 10.5)];
  const classified = classifyLines([{ pageNumber: 1, mediaBox: [0, 0, 600, 800], lines }], 10, [10.5]);
  assert.deepEqual(
    classified.map((l) => l.blockKind),
    ['list_item', 'list_item'],
  );
});

// ── wrapped tables ───────────────────────────────────────────────────────────────────────────────────────────────

const header = (y: number): Line =>
  line(
    [
      [62, '#'],
      [88, 'Step'],
      [160, 'What to do'],
      [420, 'Done when'],
    ],
    y,
  );

test('a table whose cells wrap is rebuilt row by row with header-bound cells', () => {
  const lines = [
    header(300),
    line(
      [
        [62, '1'],
        [88, 'Understand'],
        [160, 'Read the task. List inputs,'],
        [420, 'Goal is clear and written'],
      ],
      277,
    ),
    line(
      [
        [160, 'outputs, and constraints.'],
        [420, 'down'],
      ],
      264,
    ),
    line(
      [
        [62, '2'],
        [88, 'Plan'],
        [160, 'Break the work into small'],
        [420, 'Subtask list exists'],
      ],
      241,
    ),
    line([[160, 'subtasks.']], 228),
  ];
  const blocks = buildBlocks(classify(lines), 9.5);
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'table_row' ? b.cells : b.kind)),
    [
      ['#', 'Step', 'What to do', 'Done when'],
      ['1', 'Understand', 'Read the task. List inputs, outputs, and constraints.', 'Goal is clear and written down'],
      ['2', 'Plan', 'Break the work into small subtasks.', 'Subtask list exists'],
    ],
  );
  assert.ok(blocks.every((b) => b.kind === 'table_row' && b.reconstruction === 'wrapped'));
  assert.deepEqual(blocks[1]!.provenance.yRange, [277, 264]);
});

test('a line without a first-column value that is NOT a tight wrap rejects the whole table (all or nothing)', () => {
  const lines = [
    header(300),
    line(
      [
        [62, '1'],
        [88, 'Understand'],
        [160, 'Read the task.'],
        [420, 'Goal clear'],
      ],
      277,
    ),
    line(
      [
        [160, 'continuation'],
        [420, 'more'],
      ],
      264,
    ),
    line(
      [
        [62, '2'],
        [88, 'Plan'],
        [160, 'Break it down.'],
        [420, 'List exists'],
      ],
      241,
    ),
    line([[160, 'floating text far below']], 200),
  ];
  assert.equal(detectWrappedTables(classify(lines, 9.5), new Set(), 9.5).length, 0);
});

test('a table without any wrapped line is left to the single-line detector', () => {
  const lines = [
    header(300),
    line(
      [
        [62, '1'],
        [88, 'Plan'],
        [160, 'Do it.'],
        [420, 'Done'],
      ],
      277,
    ),
    line(
      [
        [62, '2'],
        [88, 'Build'],
        [160, 'Make it.'],
        [420, 'Built'],
      ],
      254,
    ),
  ];
  assert.equal(detectWrappedTables(classify(lines, 9.5), new Set(), 9.5).length, 0);
});

test('a header whose cells read like sentences is not a header', () => {
  const lines = [
    line(
      [
        [62, 'This is a sentence.'],
        [200, 'Another one.'],
        [400, 'Third.'],
      ],
      300,
    ),
    line(
      [
        [62, 'a'],
        [200, 'b c'],
        [400, 'd'],
      ],
      277,
    ),
    line([[200, 'wrapped']], 264),
    line(
      [
        [62, 'e'],
        [200, 'f'],
        [400, 'g'],
      ],
      241,
    ),
  ];
  assert.equal(detectWrappedTables(classify(lines, 9.5), new Set(), 9.5).length, 0);
});

// ── fill-in forms ────────────────────────────────────────────────────────────────────────────────────────────────

test('labels with blank or hinted values are form fields', () => {
  const lines = [
    line([[62, 'Task title']], 700),
    line(
      [
        [62, 'Task type'],
        [176, 'Feature / Bug fix / Other'],
      ],
      677,
    ),
    line([[62, 'Owner']], 654),
    line(
      [
        [62, 'Goal'],
        [176, 'What should be true when this is done?'],
      ],
      631,
    ),
  ];
  const blocks = buildBlocks(classify(lines), 10);
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'paragraph' ? b.formField : b.kind)),
    [
      { label: 'Task title' },
      { label: 'Task type', hint: 'Feature / Bug fix / Other' },
      { label: 'Owner' },
      { label: 'Goal', hint: 'What should be true when this is done?' },
    ],
  );
});

test('a label/value list where every value is filled in is data, not a form, and is unchanged', () => {
  const lines = [
    line(
      [
        [49, 'Sum Insured Basis Opted'],
        [327, 'Market Value'],
      ],
      700,
    ),
    line(
      [
        [49, 'Excess Applicable'],
        [327, 'As per policy'],
      ],
      686,
    ),
    line(
      [
        [49, 'Claim Basis'],
        [327, 'Reinstatement'],
      ],
      672,
    ),
  ];
  const blocks = buildBlocks(classify(lines), 10);
  assert.ok(blocks.every((b) => b.kind !== 'table_row' && !(b.kind === 'paragraph' && b.formField !== undefined)));
});

// ── encoding and the real fixture ────────────────────────────────────────────────────────────────────────────────

test('WinAnsi unused codes decode to the bullet character (ISO 32000-1 Annex D.2)', () => {
  const dict = (entries: Record<string, unknown>) => ({ kind: 'dictionary' as const, entries: new Map(Object.entries(entries)) as never });
  const font = dict({ Subtype: { kind: 'name', name: 'Type1' }, Encoding: { kind: 'name', name: 'WinAnsiEncoding' } });
  const resolve = buildFontEncodingResolver(dict({ Font: dict({ F1: font }) }), (v) => v);
  assert.equal(resolve('F1').decode(new Uint8Array([0x7f, 0x20, 0x41, 0x95, 0x81])), '\u2022 A\u2022\u2022');
});

test('TaskTest.pdf: rules, the wrapped workflow table, the checklist, the form and the bullets are all recovered', () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../../../examples/vertical-test/TaskTest.pdf', import.meta.url)));
  const loaded = new NodePdfLoader().load(bytes, 'TaskTest.pdf');
  assert.ok(loaded.ok);
  const blocks = allBlocks(parseDocument(loaded.value).root);
  const rules = blocks.filter((b) => b.kind === 'list_item' && b.listKind === 'ordered');
  assert.equal(rules.length, 8);
  assert.deepEqual(
    rules.map((r) => (r.kind === 'list_item' ? r.title : undefined)),
    [
      'One task, one purpose',
      'Understand before you build',
      'Work in small steps',
      'Never commit secrets',
      'Test your own work',
      'Keep it readable',
      'Do not break existing behavior',
      'Ask for review',
    ],
  );
  const rows = blocks.filter((b) => b.kind === 'table_row' && b.cells[0] !== '#');
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[2]!.kind === 'table_row' ? rows[2].cells : [], [
    '3',
    'Set up',
    'Pull latest code, create a branch (e.g. feature/short-name), confirm the project runs locally.',
    'Clean branch, app runs',
  ]);
  assert.equal(blocks.filter((b) => b.kind === 'list_item' && b.checkbox === 'unchecked').length, 9);
  assert.equal(blocks.filter((b) => b.kind === 'paragraph' && b.formField !== undefined).length, 6);
  const bullets = blocks.filter((b) => b.kind === 'list_item' && b.marker === '•');
  assert.equal(bullets.length, 4, 'the 0x7F bullets are decoded and the bullet lines are not mistaken for a heading');
});
