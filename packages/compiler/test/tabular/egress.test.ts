// UW-14b — a customer workbook can be described to a planning model without any of its values leaving the instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEgressRequest, synthesizeRecords } from '@xo/ai-core';
import { describeRecordSet, tabularFromCsv } from '../../src/tabular/index.js';

test('a client list becomes a schema descriptor and synthetic records; no cell value is in the request', () => {
  const csv =
    'Client,Email,PAN,Renewal,Premium\nAsha Rao,asha@example.com,ABCDE1234F,2027-03-31,12000\nVikram Mehta,vikram@example.org,PQRSX9876K,2027-04-15,8500.50\n';
  const t = tabularFromCsv(csv);
  assert.ok(t.ok);
  const schema = describeRecordSet(t.value.recordSets[0]!);
  assert.deepEqual(
    schema.columns.map((c) => [c.name, c.type, c.shape ?? null]),
    [
      ['Client', 'string', null],
      ['Email', 'string', null],
      ['PAN', 'string', 'AAAAA9999A'],
      ['Renewal', 'date', '9999-99-99'],
      ['Premium', 'decimal', null],
    ],
  );
  const body = JSON.stringify(
    buildEgressRequest({
      model: 'm',
      maxOutputTokens: 1,
      messages: [{ role: 'user', parts: [schema, synthesizeRecords(schema, { count: 4, seed: 'x' })] }],
    }),
  );
  for (const v of ['Asha', 'Vikram', 'asha@example.com', 'ABCDE1234F', 'PQRSX9876K', '2027-03-31', '12000', '8500.50'])
    assert.ok(!body.includes(v), v);
});
