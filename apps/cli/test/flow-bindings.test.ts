import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { buildImplementations } from '../src/commands/flow/bindings.js';

const comp = (kinds: Record<string, string>): WorkflowComponent =>
  ({
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    workflows: [],
    connectors: Object.entries(kinds).map(([id, kind]) => ({ id, kind, operations: [] })),
  }) as unknown as WorkflowComponent;
const problem = async (c: WorkflowComponent, policy: Record<string, unknown>): Promise<string> => {
  const r = await buildImplementations(c, { connectors: {}, ...policy });
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? '' : r.error;
};

test('builds every bound kind; an unbound declared connector simply has no implementation (calls fail closed)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-bind-'));
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
  };
  const db = new DatabaseSync(join(dir, 'd.sqlite'));
  db.exec('create table t(a integer); insert into t values (1)');
  db.close();
  const c = comp({ chat: 'slack_webhook', notify: 'webhook_out', lookup: 'database', out: 'file', api: 'http', unbound: 'webhook_out' });
  const r = await buildImplementations(c, {
    connectors: {},
    bindings: {
      chat: { webhookSecret: 'HOOK' },
      notify: { url: 'https://hooks.example.com/in', allowedHosts: ['hooks.example.com'], signingSecret: 'SIGN' },
      lookup: { driver: { type: 'sqlite', path: join(dir, 'd.sqlite') }, statements: { one: { sql: 'select a from t', params: [] } } },
      out: { roots: { r: join(dir, 'new-root') } },
      api: { baseUrl: 'https://api.example.com', methods: ['GET'], pathPatterns: ['/v1/**'], maxResponseBytes: 1000 },
    },
  });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(Object.keys(r.value).sort(), ['api', 'chat', 'lookup', 'notify', 'out']);
  assert.equal(r.value['unbound'], undefined);
  assert.equal(r.value['chat']!.kind, 'slack_webhook');
  assert.equal(r.value['lookup']!.kind, 'database');
});

test('the older "fileRoots" spelling still works; binding one id both ways is refused', async () => {
  const c = comp({ out: 'file' });
  const r = await buildImplementations(c, { connectors: {}, fileRoots: { out: { r: '/tmp/x' } } });
  assert.ok(r.ok && r.value['out']?.kind === 'file');
  assert.match(
    await problem(c, { fileRoots: { out: { r: '/tmp/x' } }, bindings: { out: { roots: { r: '/tmp/x' } } } }),
    /both "fileRoots" and "bindings"/,
  );
});

test('typos and widening are errors, not silent: undeclared ids, unknown keys, wrong kinds, bad values', async () => {
  const c = comp({ chat: 'slack_webhook', lookup: 'database', out: 'file', tool: 'mcp' });
  assert.match(await problem(c, { bindings: { ghost: { webhookSecret: 'x' } } }), /ghost.*no workflow/);
  assert.match(await problem(c, { bindings: { chat: { webhookSecret: 'HOOK', channel: '#ops' } } }), /unknown key\(s\) channel/);
  assert.match(await problem(c, { bindings: { chat: { webhookSecret: 'HOOK', allowedHosts: ['10.0.0.1'] } } }), /IP address/);
  assert.match(await problem(c, { bindings: { chat: { webhookSecret: 'HOOK', allowedHosts: [] } } }), /at least one host/);
  assert.match(await problem(c, { bindings: { lookup: { driver: { type: 'postgres', path: 'x' }, statements: {} } } }), /sqlite/);
  assert.match(await problem(c, { bindings: { tool: { command: 'x' } } }), /cannot bind yet/);
  assert.match(await problem(c, { bindings: { out: { roots: { r: 5 } } } }), /roots/);
  // a destructive statement in the operator's own file still refuses to start
  const dir = await mkdtemp(join(tmpdir(), 'xo-bind2-'));
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
  };
  const db = new DatabaseSync(join(dir, 'd.sqlite'));
  db.exec('create table t(a)');
  db.close();
  assert.match(
    await problem(c, {
      bindings: {
        lookup: { driver: { type: 'sqlite', path: join(dir, 'd.sqlite') }, statements: { wipe: { sql: 'delete from t', params: [] } } },
      },
    }),
    /statement "wipe" refused/,
  );
  // opening a database that is not there must not create one
  assert.match(
    await problem(c, {
      bindings: {
        lookup: { driver: { type: 'sqlite', path: join(dir, 'missing.sqlite') }, statements: { s: { sql: 'select 1', params: [] } } },
      },
    }),
    /lookup/,
  );
  assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
});

test('every problem is reported at once, naming the binding', async () => {
  const c = comp({ a: 'slack_webhook', b: 'webhook_out' });
  const msg = await problem(c, { bindings: { a: { nope: 1 }, b: { url: 'http://x.example.com/', allowedHosts: ['x.example.com'] } } });
  assert.match(msg, /binding "a"/);
  assert.match(msg, /binding "b"/);
});
