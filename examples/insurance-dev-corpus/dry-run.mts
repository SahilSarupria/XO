/**
 * End-to-end DRY RUN over the SYNTHETIC corpus through the real HTTP API (upload -> compile -> list
 * capabilities -> approve -> execute). Not phase-2 evidence (CRD-06): it shows where the path breaks.
 *
 *   node --import tsx examples/insurance-dev-corpus/dry-run.mts [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestServer } from '../../apps/api/test/test-helpers.js';

interface Cap {
  capabilityId: string;
  name: string;
  status: string;
  executionClass?: string;
  reason?: string;
  confidence: number;
}
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'labels.json'), 'utf8')) as { documents: { id: string; file: string }[] };
const server = await TestServer.start();
const rows: Record<string, unknown>[] = [];
try {
  const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
  for (const doc of manifest.documents) {
    const bytes = readFileSync(join(here, doc.file));
    const source = (await server.request('POST', `/workspaces/${ws}/sources?filename=${doc.id}.pdf`, bytes)).json<{ sourceId: string }>();
    const comp = (await server.request('POST', `/workspaces/${ws}/sources/${source.sourceId}/compile`, undefined)).json<{
      compilationId: string;
      status: string;
    }>();
    if (comp.status !== 'succeeded') {
      rows.push({ doc: doc.id, compile: comp.status });
      continue;
    }
    const caps = (await server.request('GET', `/workspaces/${ws}/compilations/${comp.compilationId}/capabilities`)).json<{
      capabilities: Cap[];
    }>().capabilities;
    const outcomes = new Map<string, number>();
    let executable = 0;
    for (const cap of caps) {
      if (cap.status !== 'resolved') {
        const k = `not-run:${cap.status}`;
        outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
        continue;
      }
      await server.request('POST', `/workspaces/${ws}/compilations/${comp.compilationId}/capabilities/${cap.capabilityId}/approve`);
      const run = (input: Record<string, number>) =>
        server.request('POST', `/workspaces/${ws}/executions`, {
          compilationId: comp.compilationId,
          capabilityId: cap.capabilityId,
          input,
        });
      let res = await run({});
      let body = res.json<{ status?: string; errorCode?: string; errorMessage?: string; error?: { code?: string }; output?: unknown }>();
      // Discover the required inputs from the validation error, then run the capability with a low and a high value.
      if (body.errorCode === 'XO_RUNTIME_CAPABILITY_INPUT_INVALID') {
        const keys = [...(body.errorMessage ?? '').matchAll(/(\w+): missing required property/g)].map((m) => m[1]!);
        const results: string[] = [];
        for (const value of [1, 1_000_000]) {
          res = await run(Object.fromEntries(keys.map((k) => [k, value])));
          const b = res.json<{ status?: string; output?: { matched?: boolean; outcome?: unknown } }>();
          results.push(
            `${value}=>${b.status}${b.output ? ` matched=${String(b.output.matched)} outcome=${JSON.stringify(b.output.outcome ?? null)}` : ''}`,
          );
        }
        if (process.env.DRY_RUN_VERBOSE) console.log('RUN', cap.name.slice(0, 60), `[${keys.join(',')}]`, results.join(' | '));
        body = { status: 'ran-with-discovered-inputs' };
      }
      if (process.env.DRY_RUN_VERBOSE && body.status === 'failed') console.log('FAILED', cap.name, '::', body.errorCode, body.errorMessage);
      const k = `${cap.executionClass ?? '?'} -> http ${res.status} ${body.status ?? body.errorCode ?? body.error?.code ?? ''}`;
      outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
      if (cap.executionClass === 'deterministic_rule') {
        executable += 1;
        if (process.env.DRY_RUN_VERBOSE) console.log('DET', cap.confidence.toFixed(2), cap.name);
      }
    }
    const conf = (lo: number, hi: number): number => caps.filter((c) => c.confidence >= lo && c.confidence < hi).length;
    rows.push({
      doc: doc.id,
      capabilities: caps.length,
      resolved: caps.filter((c) => c.status === 'resolved').length,
      deterministic: executable,
      belowFloor: caps.filter((c) => c.status === 'resolved' && c.confidence < 0.7).length,
      confidence: { '<0.5': conf(0, 0.5), '0.5-0.7': conf(0.5, 0.7), '>=0.7': conf(0.7, 1.01) },
      outcomes: Object.fromEntries([...outcomes].sort()),
      unresolvedSample: caps
        .filter((c) => c.status !== 'resolved')
        .slice(0, 2)
        .map((c) => `${c.name} :: ${c.reason ?? ''}`.slice(0, 160)),
    });
  }
} finally {
  await server.stop();
}
for (const r of rows) console.log(JSON.stringify(r, null, 1));
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1]!, JSON.stringify(rows, null, 2) + '\n');
