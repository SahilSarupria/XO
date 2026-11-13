// UW-3: document-kind classification is a traced proposal, never a decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSourceFrontend } from '../../src/sources/document-frontend.js';
import { EmlSourceFrontend } from '../../src/sources/eml-frontend.js';
import { XlsxSourceFrontend } from '../../src/sources/xlsx-frontend.js';
import { DEFAULT_DOCUMENT_KIND_CUES, proposeDocumentKinds } from '../../src/sources/kind-proposals.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { workbook, texts } from '../tabular/workbook-builder.js';

const doc = (text: string, sourcePath = 'upload.txt') => {
  const r = new DocumentSourceFrontend().ingest({ kind: 'document', text, sourcePath });
  assert.ok(r.ok);
  return r.value;
};

test('a certificate is proposed as one, with every matching cue, what it matched and where', () => {
  const [top] = proposeDocumentKinds(
    doc('# Certificate of Insurance\n\nThis is to certify that Asha Rao holds policy P-9.\n\nValid until 31 March 2027.', 'scan_0042.txt'),
  );
  assert.equal(top!.kind, 'certificate');
  assert.equal(top!.status, 'proposed');
  assert.equal(top!.method, 'cue-pack/1');
  assert.deepEqual(
    top!.evidence.map((e) => e.where),
    ['page 1', 'page 1', 'page 1'],
  );
  assert.ok(top!.evidence.some((e) => /This is to certify/.test(e.matched)));
  assert.ok(top!.score > 0 && top!.score < 1, 'no file-name cue matched, so the score is below the maximum');
});

test('workbooks are proposed from their titles and column headers; emails from their headers', () => {
  const xlsx = new XlsxSourceFrontend().ingest({
    kind: 'xlsx',
    sourcePath: 'Q1.xlsx',
    bytes: workbook([
      {
        name: 'S',
        rows: { 1: { A: { s: 'Client register' } }, 3: texts('ABC', 'Client', 'Email', 'Phone'), 4: texts('ABC', 'Asha', 'a@x.in', '98') },
      },
    ]),
  });
  assert.ok(xlsx.ok);
  const [reg] = proposeDocumentKinds(xlsx.value);
  assert.equal(reg!.kind, 'register');
  assert.ok(
    reg!.evidence.some((e) => e.where === 'S!A3'),
    JSON.stringify(reg!.evidence),
  );

  const eml = new EmlSourceFrontend().ingest({
    kind: 'eml',
    sourcePath: 'm.eml',
    bytes: new TextEncoder().encode('From: a@example.com\r\nSubject: Hello\r\n\r\nKind regards, Asha'),
  });
  assert.ok(eml.ok);
  assert.equal(proposeDocumentKinds(eml.value)[0]!.kind, 'correspondence');
});

test('nothing matching is an empty answer, not a guess; the cue pack is replaceable data', () => {
  assert.deepEqual(proposeDocumentKinds(doc('The quick brown fox.', 'notes.txt')), []);
  const pack = [{ kind: 'lab-report', label: 'Lab report', cues: [{ pattern: '\\bhaemoglobin\\b', weight: 1 }] }];
  assert.equal(proposeDocumentKinds(doc('Haemoglobin 13.5 g/dL'), pack)[0]!.kind, 'lab-report');
  assert.ok(DEFAULT_DOCUMENT_KIND_CUES.every((k) => k.cues.length > 0));
});

test('the compile report carries the proposals per source, and an image gets one from its file name alone', async () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
  ]);
  const r = await compileSources([
    { kind: 'document', text: '# Tax Invoice\n\nInvoice number 7. Amount due 1200 by 5 May.', sourcePath: 'inv.txt' },
    { kind: 'image', bytes: png, sourcePath: 'certificate_asha.png' },
  ]);
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  assert.equal(r.value.sources[0]!.kindProposals?.[0]?.kind, 'invoice');
  const image = r.value.sources[1]!;
  assert.equal(image.kindProposals?.[0]?.kind, 'certificate');
  assert.deepEqual(
    image.kindProposals?.[0]?.evidence.map((e) => e.where),
    ['file name'],
  );
});
