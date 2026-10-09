import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { observeCase } from '@xo/benchmark';
import { TestServer, withTempDir } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * `@xo/benchmark`'s observer calls the same real library functions the
 * shipped API pipeline calls (apps/api declares no importable `exports`,
 * so the short call sequence is repeated there rather than imported).
 * This test PINS that the two never diverge: the same source, compiled
 * once through the real HTTP API and once through the benchmark observer,
 * must yield the same capability set, resolutions and execution classes
 * — and running the one HITL capability through the real API execution
 * route must agree with the observer's execution outcome. If the API
 * pipeline changes and the observer does not (or vice versa), this fails
 * and the benchmark can no longer be trusted to measure the shipped path.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMMERCIAL = 'examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf';
const AASTHA = 'examples/vertical-test/Aastha.pdf';

interface CapabilityWire {
  readonly capabilityId: string;
  readonly name: string;
  readonly status: string;
  readonly executionClass?: string;
}

async function apiCapabilities(relativePath: string): Promise<{ readonly capabilities: CapabilityWire[]; readonly ctx: { readonly server: TestServer; readonly workspace: WorkspaceRecord; readonly compilationId: string } }> {
  const bytes = await readFile(`${REPO_ROOT}${relativePath}`);
  return await new Promise((resolve, reject) => {
    void withTempDir('xo-bm-equiv-data-', async (dataDir) => {
      await withTempDir('xo-bm-equiv-ws-', async (workspacesDir) => {
        const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
        try {
          const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
          const base = `/workspaces/${workspace.workspaceId}`;
          const source = (await server.request('POST', `${base}/sources?filename=${relativePath.split('/').pop()}`, bytes)).json<{ sourceId: string }>();
          const compiled = (await server.request('POST', `${base}/sources/${source.sourceId}/compile`)).json<{ compilationId: string; status: string }>();
          assert.equal(compiled.status, 'succeeded');
          const caps = (await server.request('GET', `${base}/compilations/${compiled.compilationId}/capabilities`)).json<{ capabilities: CapabilityWire[] }>().capabilities;
          resolve({ capabilities: caps, ctx: { server, workspace, compilationId: compiled.compilationId } });
        } catch (cause) {
          reject(cause);
        } finally {
          await server.stop();
        }
      });
    });
  });
}

for (const path of [COMMERCIAL, AASTHA]) {
  test(`the benchmark observer and the shipped API pipeline agree on ${path.split('/').pop()}: same capabilities, same resolution, same execution class`, async () => {
    const { capabilities } = await apiCapabilities(path);
    const observation = await observeCase({ caseId: 'equiv', sources: [{ kind: 'pdf', path }], expect: {} }, { sourceRoot: REPO_ROOT });

    const api = capabilities.map((c) => `${c.capabilityId}|${c.name}|${c.status}|${c.executionClass ?? 'not_executable'}`).sort();
    const observed = observation.capabilities.map((c) => `${c.capabilityId}|${c.name}|${c.resolution}|${c.executionClass}`).sort();
    assert.ok(api.length > 0);
    assert.deepEqual(observed, api);
  });
}

test('the benchmark observer and the shipped API execution route agree on execution outcomes (deterministic success, human escalation, refusal of an unresolved capability)', async () => {
  const bytes = await readFile(`${REPO_ROOT}${COMMERCIAL}`);
  await withTempDir('xo-bm-equiv2-data-', async (dataDir) => {
    await withTempDir('xo-bm-equiv2-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const base = `/workspaces/${workspace.workspaceId}`;
        const source = (await server.request('POST', `${base}/sources?filename=policy.pdf`, bytes)).json<{ sourceId: string }>();
        const compiled = (await server.request('POST', `${base}/sources/${source.sourceId}/compile`)).json<{ compilationId: string }>();
        const caps = (await server.request('GET', `${base}/compilations/${compiled.compilationId}/capabilities`)).json<{ capabilities: CapabilityWire[] }>().capabilities;

        const observation = await observeCase(
          {
            caseId: 'equiv',
            sources: [{ kind: 'pdf', path: COMMERCIAL }],
            expect: {},
            execution: [
              { id: 'det', kind: 'capability', target: { equals: 'The Claim Requires Manager Approval Before Settlement' }, input: { claim_amount: 15000 }, expect: { outcome: 'succeeded' } },
              { id: 'hitl', kind: 'capability', target: { equals: 'Review not covered under standard rule' }, input: {}, expect: { outcome: 'waiting_for_human' } },
              { id: 'unres', kind: 'capability', target: { contains: 'Notify the Insurer of a loss within' }, input: {}, expect: { outcome: 'not_executable' } },
            ],
          },
          { sourceRoot: REPO_ROOT },
        );
        const observedOutcome = (id: string) => (observation.executions.find((e) => e.requestId === id) as { outcome: string; output?: { matched?: boolean } }).outcome;

        const byName = (name: string) => caps.find((c) => c.name === name)!;
        const approveAndExecute = async (cap: CapabilityWire, input: Record<string, unknown>) => {
          await server.request('POST', `${base}/compilations/${compiled.compilationId}/capabilities/${cap.capabilityId}/approve`);
          return server.request('POST', `${base}/executions`, { compilationId: compiled.compilationId, capabilityId: cap.capabilityId, input });
        };

        const det = await approveAndExecute(byName('The Claim Requires Manager Approval Before Settlement'), { claim_amount: 15000 });
        assert.equal(det.status, 201, det.bodyText);
        assert.equal(det.json<{ status: string; output: { matched: boolean } }>().status, 'succeeded');
        assert.equal(observedOutcome('det'), 'succeeded');
        assert.equal((observation.executions.find((e) => e.requestId === 'det') as { output: { matched: boolean } }).output.matched, det.json<{ output: { matched: boolean } }>().output.matched);

        const hitl = await approveAndExecute(byName('Review not covered under standard rule'), {});
        assert.equal(hitl.json<{ status: string }>().status, 'waiting_for_human');
        assert.equal(observedOutcome('hitl'), 'waiting_for_human');

        const unresolved = caps.find((c) => c.name.startsWith('Notify the Insurer of a loss within'))!;
        assert.equal(unresolved.status, 'unresolved');
        assert.equal(observedOutcome('unres'), 'not_executable');
      } finally {
        await server.stop();
      }
    });
  });
});
