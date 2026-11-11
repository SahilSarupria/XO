import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from '../../api/test/test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from '../../api/test/workflow-fixtures.js';
import {
  EFFECT_FRESH_APPROVAL_REQUIRED_CODE as API_FRESH,
  EFFECT_OUTCOME_UNKNOWN_CODE as API_UNKNOWN,
  EFFECT_PAYLOAD_APPROVAL_REQUIRED_CODE as API_PAYLOAD,
} from '../../api/src/procedures/procedure-runner.js';
import { FsCompilationStore } from '../../api/src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../../api/src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../../api/src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../../api/src/workspace/workspace.js';
import { HttpXoApi } from '../src/api-client.js';
import { callTool } from '../src/call.js';
import { loadConfig } from '../src/config.js';
import {
  EFFECT_FRESH_APPROVAL_REQUIRED_CODE as MCP_FRESH,
  EFFECT_OUTCOME_UNKNOWN_CODE as MCP_UNKNOWN,
  EFFECT_PAYLOAD_APPROVAL_REQUIRED_CODE as MCP_PAYLOAD,
  discoverTools,
} from '../src/tools.js';

// P1.1 M6 — conformance at the M2/M4 <-> M5 boundary. Everything here runs WITHOUT the MCP SDK (static source reads, constants, and the
// adapter's own HTTP client against the real in-process XO API), so it complements — and does not replace — the SDK-backed
// protocol/stdio/e2e-api suites. It claims nothing about MCP protocol conformance.

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const sources = async (): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const name of (await readdir(SRC)).filter((n) => n.endsWith('.ts')).sort()) out.set(name, await readFile(join(SRC, name), 'utf8'));
  return out;
};

test('M6 boundary: the adapter source can only reach XO through its HTTP client (no runtime/adapters/store/audit/permission import, no other egress)', async () => {
  const files = await sources();
  assert.ok(files.size >= 8, 'source files were found');
  // Reviewing a NEW import here is the point: adding one means deliberately widening what the adapter could use as authority.
  const ALLOWED = [
    /^\.\//,
    /^node:crypto$/,
    /^node:stream$/,
    /^@modelcontextprotocol\/sdk\//,
    /^@xo\/capability-contract$/,
    /^@xo\/types$/,
  ];
  const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const [name, text] of files) {
    for (const m of text.matchAll(specifier)) {
      const spec = m[1] as string;
      assert.ok(
        ALLOWED.some((re) => re.test(spec)),
        `${name} imports "${spec}", which is outside the reviewed adapter boundary`,
      );
    }
  }
  // The SDK is confined to the protocol layer; the decision logic (tools/call/api-client/config) is SDK-free and authority-free.
  const sdkUsers = [...files].filter(([, t]) => t.includes('@modelcontextprotocol/sdk')).map(([n]) => n);
  assert.deepEqual(sdkUsers, ['server.ts', 'stdio.ts']);
  // Credentials: the variable names appear only in config.ts; the process environment is read in exactly one place (the entrypoint).
  for (const [name, text] of files) {
    if (name !== 'config.ts') assert.equal(/XO_API_KEY/.test(text), false, `${name} must not name the credential variable`);
    if (name !== 'main.ts') assert.equal(/process\.env/.test(text), false, `${name} must not read the process environment`);
    if (name !== 'api-client.ts') assert.equal(/\bfetch\s*\(/.test(text), false, `${name} must not issue network requests`);
  }
});

test('M6 boundary: diagnostics never carry arguments, results, headers, keys or the credential (call sites are pinned to an allowlist of scalar fields)', async () => {
  const FIELDS = new Set(['count', 'reason', 'tool', 'error', 'message', 'workspace']);
  const FORBIDDEN = /\b(arguments|args|apiKey|authorization|headers|idempotencyKey|structured|outputs|input|env|text)\b/;
  let calls = 0;
  for (const [name, text] of await sources()) {
    if (name === 'logger.ts') continue;
    for (const m of text.matchAll(/\blogger\.(?:info|warn)\(([^;]*)\);/g)) {
      calls += 1;
      const args = m[1] as string;
      assert.equal(FORBIDDEN.test(args), false, `${name}: logger call references a forbidden value: ${args}`);
      for (const f of args.matchAll(/[{,]\s*(\w+)\s*:/g)) {
        assert.ok(FIELDS.has(f[1] as string), `${name}: logger field "${f[1]}" is not on the allowlist`);
      }
    }
  }
  assert.ok(calls >= 7, `expected the known logger call sites, found ${calls}`);
});

test('M6 boundary: the adapter and the API agree on every external-effect code the adapter interprets (not only "unknown")', () => {
  assert.equal(MCP_UNKNOWN, API_UNKNOWN);
  assert.equal(MCP_PAYLOAD, API_PAYLOAD);
  assert.equal(MCP_FRESH, API_FRESH);
});

// ---- M2 lifecycle <-> M5 eligibility, against the REAL API --------------------------------------------------------------------------

const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const RULES = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];

test('M6 boundary: eligibility is computed by the API at read time — once the approval can no longer be verified the version is not advertised, not callable, carries no schema, and the API itself refuses a start', async () => {
  await withTempDir('xo-m6-data-', async (dataDir) => {
    await withTempDir('xo-m6-ws-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: new NonProductionAuditSink(),
        permissionPolicy: new RuleBasedPolicy([...RULES]),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const graphHash = loaded.graphHash;
        const ws = `/workspaces/${workspace.workspaceId}`;
        const cap = await server.request('POST', `${ws}/compilations/${compilationId}/capabilities/${IDS.xsegA}/approve`);
        assert.ok(cap.status === 200 || cap.status === 201, cap.bodyText);
        const doc = {
          schema: 'xo.procedure/1',
          procedureId: 'intake-one',
          version: 1,
          compilationRef: { compilationId, graphHash },
          steps: [
            {
              id: 'a',
              kind: 'capability',
              capabilityId: IDS.xsegA,
              basis: 'source_proven',
              inputBindings: [{ param: 'intake score', from: { input: 'intake_score' }, bindingStatus: 'proven' }],
            },
          ],
        };
        {
          const put = await server.request('PUT', `${ws}/procedures/intake-one/versions/1`, doc);
          assert.equal(put.status, 201, put.bodyText);
        }
        assert.equal((await server.request('POST', `${ws}/procedures/intake-one/versions/1/approve`)).status, 200);

        const api = new HttpXoApi(
          loadConfig({ XO_API_KEY: server.apiKey, XO_API_URL: server.baseUrl, XO_WORKSPACE_ID: workspace.workspaceId }),
        );
        const signal = new AbortController().signal;
        const executions = async (): Promise<number> => {
          try {
            return (await readdir(join(dataDir, workspace.workspaceId, 'procedure-executions'))).length;
          } catch {
            return 0;
          }
        };

        // While approved: advertised with the server-derived schema, and callable (one execution).
        const before = await discoverTools(api, signal);
        assert.ok(before.kind === 'ok', JSON.stringify(before));
        assert.deepEqual(
          before.tools.map((t) => t.name),
          ['intake-one.v1'],
        );
        const ran = await callTool(api, { name: 'intake-one.v1', arguments: { intake_score: 1 }, idempotencyKey: 'm6-boundary-1', signal });
        assert.equal(ran.isError, false, JSON.stringify(ran));
        assert.equal(ran.structured['outcome'], 'completed');
        assert.equal(await executions(), 1);

        // The registry evidence behind the approval disappears (same technique as the M2 approval_unverifiable test).
        const blobs = new LocalFsBlobStore(join(dataDir, workspace.workspaceId, 'compilations'));
        assert.ok((await blobs.delete(`${compilationId}/result.json`)).ok);

        const detail = await server.request('GET', `${ws}/procedures/intake-one?version=1`);
        assert.equal(detail.status, 200);
        const body = detail.json<Record<string, unknown>>();
        assert.equal(body['lifecycle'], 'approval_unverifiable');
        assert.equal('inputSchema' in body, false, 'a version whose approval cannot be verified is never given a schema');

        const after = await discoverTools(api, signal);
        assert.ok(after.kind === 'ok', JSON.stringify(after));
        assert.deepEqual(after.tools, [], 'no longer advertised');

        const blocked = await callTool(api, {
          name: 'intake-one.v1',
          arguments: { intake_score: 1 },
          idempotencyKey: 'm6-boundary-2',
          signal,
        });
        assert.equal(blocked.isError, true);
        assert.equal(blocked.structured['outcome'], 'not_started', 'the adapter sends no start for a version it cannot see as approved');

        // The adapter is not the gate: a direct start on the API is refused by the API's own lifecycle check.
        const direct = await server.request('POST', `${ws}/procedures/intake-one/versions/1/executions`, { input: { intake_score: 1 } });
        assert.ok(direct.status >= 400 && direct.status < 500, `direct start -> ${direct.status} ${direct.bodyText}`);
        assert.equal(await executions(), 1, 'neither path created an execution after the approval became unverifiable');
      } finally {
        await server.stop();
      }
    });
  });
});
