/** UW-15 (ADR 0044), UAC-34: next month's workbook with a renamed or retyped column is caught, with a plain report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonProductionAuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const JAN = [
  'Name,Email,Amount,Due',
  'Asha Rao,asha@x.example,100,2026-01-31',
  'Bala K,bala@x.example,250,2026-01-31',
  'Chen W,chen@x.example,75,2026-01-31',
].join('\n');

test('drift: the same file is none; a renamed column and a retyped column block, with the new name suggested; a new column warns', async () => {
  await withTempDir('xo-api-drift-', async (dataDir) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const up = async (csv: string) =>
        (await server.request('POST', `/workspaces/${ws}/sources?filename=clients.csv`, Buffer.from(csv))).json<{ sourceId: string }>();
      const first = await up(JAN);
      const compile = await server.request('POST', `/workspaces/${ws}/sources/${first.sourceId}/compile`);
      assert.equal(compile.status, 201, compile.bodyText);
      const cid = compile.json<{ compilationId: string }>().compilationId;
      const drift = async () =>
        (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/data-drift`)).json<{
          drift: {
            status: string;
            checkedSources: number;
            sources: { tables: { report: { differences: { kind: string; header: string; renamedTo?: string; severity: string }[] } }[] }[];
          };
        }>().drift;

      assert.deepEqual(await drift(), { status: 'none', sources: [], checkedSources: 1 }, 'nothing newer to compare');

      await up(JAN.replace('2026-01-31', '2026-02-28').replaceAll('2026-01-31', '2026-02-28')); // next month, same shape
      assert.equal((await drift()).status, 'none');

      await up(JAN.replace('Email', 'E-mail address'));
      const renamed = await drift();
      assert.equal(renamed.status, 'blocking');
      assert.deepEqual(
        renamed.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.header, d.renamedTo]),
        [['column_missing', 'Email', 'E-mail address']],
      );

      await up(JAN.replace('100', 'one hundred').replace('250', 'n/a').replace('75', 'tbc'));
      const retyped = await drift();
      assert.equal(retyped.status, 'blocking');
      assert.deepEqual(
        retyped.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.header]),
        [['type_changed', 'Amount']],
      );

      await up(
        [
          'Name,Email,Amount,Due,Notes',
          'Asha Rao,asha@x.example,100,2026-01-31,x',
          'Bala K,bala@x.example,250,2026-01-31,y',
          'Chen W,chen@x.example,75,2026-01-31,z',
        ].join('\n'),
      );
      const added = await drift();
      assert.equal(added.status, 'warning');
      assert.deepEqual(
        added.sources[0]!.tables[0]!.report.differences.map((d) => [d.kind, d.severity]),
        [['column_added', 'warning']],
      );
      assert.equal((await server.request('GET', `/workspaces/${ws}/compilations/cmp_nope/data-drift`)).status, 404);
    } finally {
      await server.stop();
    }
  });
});

const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

test('a workflow compiled from a procedure is linked to the table it reads: a renamed column there stops the start before any run', async () => {
  await withTempDir('xo-api-drift-reads-', async (dataDir) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const up = async (name: string, body: string) =>
        (await server.request('POST', `/workspaces/${ws}/sources?filename=${name}`, Buffer.from(body))).json<{ sourceId: string }>();
      const proc = await up('release.md', PROCEDURE);
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${proc.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const clients = await up('clients.csv', JAN);
      const goal = { text: 'Ship a release', needs: ['Run the full test suite'] };
      const gen = (reads: unknown) => server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal, reads });

      // A read must name a real table; the link is part of what the definition is.
      assert.equal((await gen([{ sourceId: clients.sourceId, recordSetId: 'nope' }])).status, 400);
      const plain = (await gen(undefined)).json<{ definition: { definitionId: string } }>().definition;
      const linked = (await gen([{ sourceId: clients.sourceId, recordSetId: '#1' }])).json<{
        definition: { definitionId: string; dataReads: { name: string; recordSetId: string }[] };
      }>().definition;
      assert.notEqual(linked.definitionId, plain.definitionId);
      assert.deepEqual(
        linked.dataReads.map((r) => [r.name, r.recordSetId]),
        [['clients.csv', '#1']],
      );

      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${linked.definitionId}/readiness`, {})).json<{
        certificateId: string;
      }>();
      await up('clients.csv', JAN.replace('Email', 'E-mail address')); // next month's list, a column renamed
      const runs = `/workspaces/${ws}/generated-workflows/${linked.definitionId}/runs`;
      const refused = await server.request('POST', runs, { input: {}, certificateId: cert.certificateId });
      assert.equal(refused.status, 409, refused.bodyText);
      assert.match(refused.bodyText, /XO_DATA_SCHEMA_DRIFT/);
      assert.match(refused.bodyText, /clients\.csv: the column .*Email.* is no longer there/);
      assert.equal((await server.request('GET', runs)).json<{ runs: unknown[] }>().runs.length, 0, 'no run record exists');
      assert.equal(sink.events().filter((e) => e.type === 'generated-workflow.drift.refused').length, 1);
      // Without the link the same workflow starts: the gate checks only what the workflow says it reads.
      const plainCert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${plain.definitionId}/readiness`, {})).json<{
        certificateId: string;
      }>();
      const started = await server.request('POST', `/workspaces/${ws}/generated-workflows/${plain.definitionId}/runs`, {
        input: {},
        certificateId: plainCert.certificateId,
      });
      assert.equal(started.status, 201, started.bodyText);
    } finally {
      await server.stop();
    }
  });
});
