import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';

const load = (name: string) => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/encrypted/${name}`, import.meta.url))));
  return new NodePdfLoader().load(bytes, name);
};

for (const name of ['q-owner-aes-128.pdf', 'q-owner-aes-256-r5.pdf', 'q-owner-aes-256-r6.pdf']) {
  test(`decrypt: ${name} (written by qpdf, empty user password) is read`, () => {
    const r = load(name);
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(r.value.pageCount, 3);
    for (const p of r.value.pages) assert.equal(p.loadFailure, undefined);
    assert.match(r.value.pages[0]!.plainText, /Insured must notify the Insurer/);
  });
}

test('decrypt: a document that needs a user password is refused loudly, never read as garbage', () => {
  const r = load('q-user-aes-256-r6.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : String(r.error.code), 'XO_PDF_ENCRYPTED');
  assert.match(r.ok ? '' : r.error.message, /password/);
});
