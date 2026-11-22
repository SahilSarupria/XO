// V1-1 (ADR 0049, V1-G2): the items of a batch, built from a confirmed table or "each person's document" pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceItems, fieldNames, SourceItemsError, type SourceDocument } from '../src/index.js';

const doc = (key: string, sha: string): SourceDocument => ({
  key,
  name: key.split('/').at(-1)!,
  digestSha256: sha.repeat(64).slice(0, 64),
  contentType: 'application/pdf',
});

test('field names come from the headers: lower snake case, unique, never a document field', () => {
  assert.deepEqual(
    fieldNames(['Client name', 'E-mail', 'Policy No.', '', '2024 premium', 'client_name', 'Document SHA256', 'emailAddress']),
    ['client_name', 'e_mail', 'policy_no', 'column_4', 'c_2024_premium', 'client_name_2', 'document_sha256_2', 'email_address'],
  );
});

test('a table: one item per row, cells as stored (trimmed); blank rows are reported, not sent', () => {
  const r = buildSourceItems({
    headers: ['Name', 'Email'],
    rows: [
      ['Asha Rao', ' asha@x.in '],
      ['', ''],
      ['Vikram Mehta', 'vikram@x.in'],
    ],
  });
  assert.deepEqual(r.fields, ['name', 'email']);
  assert.deepEqual(r.items, [
    { name: 'Asha Rao', email: 'asha@x.in' },
    { name: 'Vikram Mehta', email: 'vikram@x.in' },
  ]);
  assert.deepEqual(r.rows, [1, 3]);
  assert.deepEqual(r.excludedRows, [{ row: 2, reason: 'blank' }]);
});

test('each person’s document: exactly one document per row, or the row is left out with why; nothing is guessed', () => {
  const r = buildSourceItems({
    headers: ['Client name', 'Email'],
    rows: [
      ['Asha Rao', 'asha@x.in'], // one document
      ['Vikram Mehta', 'vikram@x.in'], // two documents
      ['Zoya Khan', 'zoya@x.in'], // none
      ['Imran Ali', 'imran1@x.in'], // the same name on two rows
      ['Imran Ali', 'imran2@x.in'],
      ['12345', 'nobody@x.in'], // no name
      ['Katherine Iyer', 'kate@x.in'], // matched by a short form of the first name
    ],
    pairing: {
      nameColumn: 'Client name',
      documents: [
        doc('Certificates/Asha_Rao_certificate.pdf', 'a'),
        doc('Certificates/vikram-mehta-2025.pdf', 'b'),
        doc('Certificates/Vikram Mehta certificate.pdf', 'c'),
        doc('Certificates/Imran Ali.pdf', 'd'),
        doc('Certificates/Kate Iyer.pdf', 'e'),
        doc('Certificates/summary.pdf', 'f'),
      ],
    },
  });
  assert.deepEqual(r.fields, ['client_name', 'email', 'document_sha256', 'document_name', 'document_type']);
  assert.deepEqual(r.items, [
    {
      client_name: 'Asha Rao',
      email: 'asha@x.in',
      document_sha256: 'a'.repeat(64),
      document_name: 'Asha_Rao_certificate.pdf',
      document_type: 'application/pdf',
    },
    {
      client_name: 'Katherine Iyer',
      email: 'kate@x.in',
      document_sha256: 'e'.repeat(64),
      document_name: 'Kate Iyer.pdf',
      document_type: 'application/pdf',
    },
  ]);
  assert.deepEqual(r.rows, [1, 7]);
  assert.deepEqual(r.excludedRows, [
    { row: 2, reason: 'several_documents' },
    { row: 3, reason: 'no_document' },
    { row: 4, reason: 'name_on_several_rows' },
    { row: 5, reason: 'name_on_several_rows' },
    { row: 6, reason: 'no_name' },
  ]);
  assert.deepEqual(r.excludedDocuments, [{ name: 'summary.pdf', reason: 'matches_no_one' }]);
  assert.deepEqual(r.looseRows, [{ row: 7, kind: 'nickname' }]);
});

test('a pairing whose name column is gone is refused, not paired by another column', () => {
  assert.throws(
    () =>
      buildSourceItems({ headers: ['Name', 'Email'], rows: [['A B', 'a@x.in']], pairing: { nameColumn: 'Client name', documents: [] } }),
    (e: unknown) => e instanceof SourceItemsError && e.code === 'name_column_missing',
  );
});
