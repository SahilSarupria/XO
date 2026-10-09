import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { buildTestPdf, type TestPdfSpec } from '../pdf/fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

async function chunkPdf(spec: TestPdfSpec, documentPath = 'test.pdf') {
  const pdf = buildTestPdf(spec);
  const loaded = loader.load(pdf, documentPath);
  assert.ok(loaded.ok);
  if (!loaded.ok) throw loaded.error;
  const parsed = parseDocument(loaded.value);
  return chunkDocument(parsed, documentPath, loaded.value.metadata.title);
}

test('a heading followed by a paragraph produces one unit anchored to that heading', async () => {
  const doc = await chunkPdf({
    pages: [{ contentOps: '/F1 20 Tf 72 750 Td (Confidentiality) Tj /F1 12 Tf 0 -40 Td (The parties agree to keep information private.) Tj' }],
  });
  assert.equal(doc.units.length, 1);
  assert.equal(doc.units[0]!.title, 'Confidentiality');
  assert.equal(doc.units[0]!.hierarchy.parentUnitId, undefined);
});

test('a definition and a later use of the defined term produce a defines relationship', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 12 Tf 72 750 Td ("Confidential Information" means any data disclosed under this Agreement.) Tj ' +
          '0 -60 Td (The Receiving Party shall protect all Confidential Information from disclosure.) Tj',
      },
    ],
  });
  const definitionUnit = doc.units.find((u) => u.semanticType === 'definition');
  assert.ok(definitionUnit);
  const definesEdge = doc.relationshipGraph.relationships.find((r) => r.type === 'defines' && r.fromUnitId === definitionUnit!.id);
  assert.ok(definesEdge);
});

test('an example paragraph produces a supports relationship to the preceding clause', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 12 Tf 72 750 Td (Trade secrets must be protected under this clause.) Tj ' +
          '0 -60 Td (For example, source code and pricing models are covered.) Tj',
      },
    ],
  });
  const exampleUnit = doc.units.find((u) => u.semanticType === 'example');
  assert.ok(exampleUnit);
  const supportsEdge = doc.relationshipGraph.relationships.find((r) => r.type === 'supports' && r.fromUnitId === exampleUnit!.id);
  assert.ok(supportsEdge);
});

test('a section that mentions another section\'s heading produces a references relationship', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Termination) Tj ' +
          '/F1 12 Tf 0 -40 Td (This section explains how the Agreement ends.) Tj ' +
          '/F1 20 Tf 0 -60 Td (Governing Law) Tj ' +
          '/F1 12 Tf 0 -40 Td (Disputes arising under Termination shall be resolved by arbitration.) Tj',
      },
    ],
  });
  const governingLawIntro = doc.units.find((u) => u.title === 'Governing Law');
  assert.ok(governingLawIntro);
  const referencesEdge = doc.relationshipGraph.relationships.find((r) => r.type === 'references' && r.fromUnitId === governingLawIntro!.id);
  assert.ok(referencesEdge);
});

test('a subsection\'s anchor unit extends its parent section\'s anchor unit', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Article 1) Tj ' +
          '/F1 16 Tf 0 -50 Td (1.1 Scope) Tj ' +
          '/F1 12 Tf 0 -40 Td (Body text for the subsection.) Tj',
      },
    ],
  });
  const parentUnit = doc.units.find((u) => u.title === 'Article 1');
  const childUnit = doc.units.find((u) => u.title === '1.1 Scope');
  assert.ok(parentUnit && childUnit);
  assert.equal(childUnit!.hierarchy.parentUnitId, parentUnit!.id);
  const extendsEdge = doc.relationshipGraph.relationships.find((r) => r.type === 'extends' && r.fromUnitId === childUnit!.id && r.toUnitId === parentUnit!.id);
  assert.ok(extendsEdge);
});

test('list items become separate sibling units', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 18 Tf 72 750 Td (Obligations) Tj ' +
          '/F1 12 Tf 0 -50 Td (1. Maintain confidentiality) Tj ' +
          '0 -20 Td (2. Return all materials) Tj',
      },
    ],
  });
  const listUnits = doc.units.filter((u) => u.semanticType === 'clause');
  assert.equal(listUnits.length, 2);
  assert.ok(listUnits[0]!.hierarchy.siblingUnitIds.includes(listUnits[1]!.id));
});

test('P0.9A area E: a numbered list item\'s unit carries listKind "ordered" end-to-end through the real chunker', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 18 Tf 72 750 Td (Obligations) Tj ' +
          '/F1 12 Tf 0 -50 Td (1. Maintain confidentiality) Tj ' +
          '0 -20 Td (2. Return all materials) Tj',
      },
    ],
  });
  const listUnits = doc.units.filter((u) => u.semanticType === 'clause');
  assert.equal(listUnits.length, 2);
  assert.equal(listUnits[0]!.listKind, 'ordered');
  assert.equal(listUnits[1]!.listKind, 'ordered');
});

test('P0.9A area E: a bulleted list item\'s unit carries listKind "unordered" end-to-end through the real chunker', async () => {
  const doc = await chunkPdf({
    pages: [
      {
        contentOps:
          '/F1 18 Tf 72 750 Td (Systems) Tj ' +
          '/F1 12 Tf 0 -50 Td (- CRM manages policy booking) Tj ' +
          '0 -20 Td (- Tally Prime manages invoicing) Tj',
      },
    ],
  });
  const listUnits = doc.units.filter((u) => u.semanticType === 'clause');
  assert.equal(listUnits.length, 2);
  assert.equal(listUnits[0]!.listKind, 'unordered');
  assert.equal(listUnits[1]!.listKind, 'unordered');
});

test('P0.9A area E: an ordinary (non-list) unit has no listKind at all', async () => {
  const doc = await chunkPdf({
    pages: [{ contentOps: '/F1 20 Tf 72 750 Td (Confidentiality) Tj /F1 12 Tf 0 -40 Td (The parties agree to keep information private.) Tj' }],
  });
  assert.equal(doc.units[0]!.listKind, undefined);
});

test('a footnote becomes its own explanatory_note unit', async () => {
  const doc = await chunkPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Body text on the page.) Tj /F1 8 Tf 0 -660 Td (This is a footnote.) Tj' }],
  });
  const footnoteUnit = doc.units.find((u) => u.semanticType === 'explanatory_note');
  assert.ok(footnoteUnit);
  assert.match(footnoteUnit!.content, /This is a footnote/);
});

test('every unit carries provenance: document path, pages, and section path', async () => {
  const doc = await chunkPdf({ pages: [{ contentOps: '/F1 20 Tf 72 750 Td (Intro) Tj /F1 12 Tf 0 -40 Td (Body text.) Tj' }] }, 'my-contract.pdf');
  const unit = doc.units[0]!;
  assert.equal(unit.provenance.documentPath, 'my-contract.pdf');
  assert.deepEqual(unit.provenance.pages, [1]);
  assert.deepEqual(unit.provenance.sectionPath, ['Intro']);
});

test('compiling the same document twice produces byte-for-byte identical Experience Units (determinism)', async () => {
  const spec: TestPdfSpec = {
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Definitions) Tj ' +
          '/F1 12 Tf 0 -40 Td ("Party" means either signatory to this Agreement.) Tj ' +
          '0 -40 Td (1. Each Party shall act in good faith.) Tj',
      },
    ],
  };
  const docA = await chunkPdf(spec);
  const docB = await chunkPdf(spec);
  assert.deepEqual(docA, docB);
});
