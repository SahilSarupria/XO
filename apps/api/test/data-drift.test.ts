/** UW-15 (ADR 0044), UAC-34: next month's workbook with a renamed or retyped column is caught, with a plain report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonProductionAuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const JAN = ['Name,Email,Amount,Due', 'Asha Rao,asha@x.example,100,2026-01-31', 'Bala K,bala@x.example,250,2026-01-31', 'Chen W,chen@x.example,75,2026-01-31'].join('\n');

test('drift: the same file is none; a renamed column and a retyped column block, with the new name suggested; a new column warns', async () => {
  await withTempDir('xo-api-drift-', async (dataDir) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const up = async (csv: string) => (await server.request('POST', `/workspaces/${ws}/sources?filename=clients.csv`, Buffer.from(csv))).json<{ sourceId: string }>();
      const first = await up(JAN);
      const compile = await server.request('POST', `/workspaces/${ws}/sources/${first.sourceId}/compile`);
      assert.equal(compile.status, 201, compile.bodyText);
      const cid = compile.json<{ compilationId: string }>().compilationId;
      const drift = async () => (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/data-drift`)).json<{ drift: { status: string; checkedSources: number; sources: { tables: { report: { differences: { kind: string; header: string; renamedTo?: string; severity: string }[] } }[] }[] } }>().drift;

      assert.deepEqual(await drift(), { status: 'none', sources: [], checkedSources: 1 }, 'nothing newer to compare');

      await up(JAN.replace('2026-01-31', '2026-02-28').replaceAll('2026-01-31', '2026-02-28')); // next month, same shape
      assert.equal((await drift()).status, 'none');

      await up(JAN.replace('Email', 'E-mail address'));
      const renamed = await drift();
      assert.equal(renamed.status, 'blocking');
      assert.deepEqual(renamed.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.header, d.renamedTo]), [['column_missing', 'Email', 'E-mail address']]);

      await up(JAN.replace('100', 'one hundred').replace('250', 'n/a').replace('75', 'tbc'));
      const retyped = await drift();
      assert.equal(retyped.status, 'blocking');
      assert.deepEqual(retyped.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.header]), [['type_changed', 'Amount']]);

      await up(['Name,Email,Amount,Due,Notes', 'Asha Rao,asha@x.example,100,2026-01-31,x', 'Bala K,bala@x.example,250,2026-01-31,y', 'Chen W,chen@x.example,75,2026-01-31,z'].join('\n'));
      const added = await drift();
      assert.equal(added.status, 'warning');
      assert.deepEqual(added.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.severity]), [['column_added', 'warning']]);
      assert.equal((await server.request('GET', `/workspaces/${ws}/compilations/cmp_nope/data-drift`)).status, 404);
    } finally {
      await server.stop();
    }
  });
});
