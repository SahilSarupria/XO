// UW-15 (ADR 0044), UAC-34: a changed workbook is caught before any effect, with a plain report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabularFromCsv } from '@xo/compiler';
import { detectDrift, fingerprintRecordSet, normaliseHeader, valueShape } from '../src/index.js';

const fp = (csv: string) => {
  const t = tabularFromCsv(csv);
  assert.ok(t.ok);
  if (!t.ok) throw new Error('csv');
  return fingerprintRecordSet(t.value.recordSets[0]!);
};
const JAN = ['Name,Email,Amount,Due', 'Asha Rao,asha@x.example,100,2026-01-31', 'Bala K,bala@x.example,250,2026-01-31', 'Chen W,chen@x.example,75,2026-01-31', 'Dee P,dee@x.example,310,2026-01-31'].join('\n');
const baseline = fp(JAN);

test('the same workbook, reordered columns, extra whitespace and different header case: no drift', () => {
  const r = detectDrift(baseline, fp(['  AMOUNT ,due,NAME,email', '100,2026-02-28,Asha Rao,asha@x.example', '250,2026-02-28,Bala K,bala@x.example', '75,2026-02-28,Chen W,chen@x.example', '310,2026-02-28,Dee P,dee@x.example'].join('\n')));
  assert.equal(r.status, 'none', JSON.stringify(r.differences));
  assert.equal(r.checkedColumns, 4);
});

test('a renamed column stops the run, and the report says which column it probably became', () => {
  const r = detectDrift(baseline, fp(JAN.replace('Email', 'E-mail address')));
  assert.equal(r.status, 'blocking');
  assert.deepEqual(r.differences.map((d) => [d.kind, d.header, d.renamedTo]), [['column_missing', 'Email', 'E-mail address']]);
  assert.match(r.differences[0]!.message, /no longer there/);
});

test('a removed column blocks; a retyped column blocks; a changed format pattern blocks', () => {
  assert.equal(detectDrift(baseline, fp(['Name,Email,Due', 'A B,a@x.example,2026-01-31', 'C D,c@x.example,2026-01-31', 'E F,e@x.example,2026-01-31'].join('\n'))).differences[0]!.kind, 'column_missing');
  const retyped = detectDrift(baseline, fp(JAN.replace('100', 'one hundred').replace('250', 'n/a').replace('75', 'tbc')));
  assert.deepEqual(retyped.differences.map((d) => [d.kind, d.header]), [['type_changed', 'Amount']]);
  // Dates written another way stop being dates at all: a type change.
  const dates = detectDrift(baseline, fp(JAN.replaceAll('2026-01-31', '31/01/2026')));
  assert.deepEqual(dates.differences.map((d) => [d.kind, d.header, d.was, d.now]), [['type_changed', 'Due', 'date', 'string']]);
  // Same type, different pattern: a format change.
  const refs = fp(['Ref,Name', 'AB-123,A', 'CD-456,B', 'EF-789,C', 'GH-012,D'].join('\n'));
  const format = detectDrift(refs, fp(['Ref,Name', 'AB123,A', 'CD456,B', 'EF789,C', 'GH012,D'].join('\n')));
  assert.deepEqual(format.differences.map((d) => [d.kind, d.header, d.was, d.now]), [['format_changed', 'Ref', 'A-999', 'A999']]);
});

test('a new column nothing uses is a warning only; if the workflow uses only some columns, changes elsewhere are not blocking', () => {
  const withNew = detectDrift(baseline, fp(JAN.replace('Name,', 'Name,Notes,').replace(/\n(.*?),/g, '\n$1,x,')));
  assert.equal(withNew.status, 'warning');
  assert.deepEqual(withNew.differences.map((d) => [d.kind, d.severity]), [['column_added', 'warning']]);
  const onlyEmail = detectDrift(baseline, fp(JAN.replace('Amount', 'Total').replaceAll('2026-01-31', '31/01/2026')), ['email', ' NAME ']);
  // The renamed and reformatted columns are not used: only the new name is noted, and nothing blocks.
  assert.equal(onlyEmail.status, 'warning');
  assert.deepEqual(onlyEmail.differences.map((d) => d.severity), ['warning']);
  assert.equal(onlyEmail.checkedColumns, 2);
});

test('normalisation and shapes are deterministic and idempotent', () => {
  for (const h of ['  Due  Date ', 'ÉCOLE', 'Ａｍｏｕｎｔ', 'a\tb']) {
    assert.equal(normaliseHeader(normaliseHeader(h)), normaliseHeader(h));
  }
  assert.equal(valueShape('2026-01-31'), '9999-99-99');
  assert.equal(valueShape('Asha Rao'), 'Aa Aa');
  assert.equal(valueShape('asha@x.example'), 'a@a.a');
  assert.equal(fp(JAN).digest, fp(JAN).digest);
  assert.notEqual(fp(JAN).digest, fp(JAN.replace('Email', 'Mail')).digest);
});
