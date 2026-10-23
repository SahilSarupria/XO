import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packBundle } from '@xo/package-sdk';
import { TestServer } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { applySettingsPatch, DEFAULT_SETTINGS, parseSettingsPatch } from '../src/settings/workspace-settings.js';
import { classify } from '../src/routes/notification-routes.js';
import type { AuditEntry } from '../src/audit/audit-entry.js';

async function withDirs<T>(fn: (dirs: { workspacesDir: string; workspaceDataDir: string }) => Promise<T>): Promise<T> {
  const workspacesDir = await mkdtemp(join(tmpdir(), 'xo-api-test-ws-'));
  const workspaceDataDir = await mkdtemp(join(tmpdir(), 'xo-api-test-wsdata-'));
  try {
    return await fn({ workspacesDir, workspaceDataDir });
  } finally {
    await rm(workspacesDir, { recursive: true, force: true });
    await rm(workspaceDataDir, { recursive: true, force: true });
  }
}

interface SettingsWire {
  settings: {
    revision: number;
    airGapped: boolean;
    model: { primary: { provider: string; model: string } | null; fallback: unknown };
    trust: { requireSignedPackages: boolean };
    residency: { region: string | null };
    notifications: Record<string, boolean>;
    runtime: { location: string };
  };
  effect: Record<string, any>;
}

async function boot(dirs: { workspacesDir: string; workspaceDataDir: string }) {
  const server = await TestServer.start(dirs);
  const ws = (await server.request('POST', '/workspaces', { name: 'S' })).json<{ workspaceId: string }>().workspaceId;
  return { server, ws, base: `/workspaces/${ws}` };
}

test('defaults, and the effect block states what is enforced vs declared', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const res = (await server.request('GET', `${base}/settings`)).json<SettingsWire>();
      assert.equal(res.settings.revision, 0);
      assert.equal(res.settings.airGapped, false);
      assert.equal(res.settings.runtime.location, 'this_computer');
      assert.equal(res.settings.residency.region, null);
      assert.equal(res.effect['residency'].enforced, false);
      assert.equal(res.effect['airGapped'].enforced, true);
      assert.equal(res.effect['trust'].requireCompilerAttestation.available, false);
      assert.deepEqual(res.effect['runtime'].availableLocations, ['this_computer']);
      assert.ok(res.effect['model'].providers.every((p: { id: string; configured: boolean }) => typeof p.configured === 'boolean'));
      assert.ok(!JSON.stringify(res).match(/api[_-]?key"\s*:\s*"/i), 'no credential material is ever returned');
    } finally {
      await server.stop();
    }
  });
});

test('PUT applies a partial patch, bumps the revision, updates the workspace region, and is audited', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, base } = await boot(dirs);
    try {
      const res = await server.request('PUT', `${base}/settings`, {
        expectedRevision: 0,
        region: 'in-mumbai',
        model: { primary: { provider: 'anthropic', model: 'claude-sonnet' }, fallback: { provider: 'ollama', model: 'llama3' } },
        notifications: { onWorkflowComplete: true },
      });
      assert.equal(res.status, 200, res.bodyText);
      const body = res.json<SettingsWire>();
      assert.equal(body.settings.revision, 1);
      assert.equal(body.settings.residency.region, 'in-mumbai');
      assert.equal(body.settings.model.primary?.provider, 'anthropic');
      assert.deepEqual(body.settings.notifications, { onEscalation: true, onRunFailure: true, onWorkflowComplete: true });
      assert.equal((await server.request('GET', `/workspaces/${ws}`)).json<{ region: string }>().region, 'in-mumbai');
      const audit = (await server.request('GET', `${base}/audit/events?event=settings.updated`)).json<{
        events: { detail: { changed: string[] } }[];
      }>();
      assert.deepEqual(audit.events[0]?.detail.changed.sort(), ['model', 'notifications', 'region']);
    } finally {
      await server.stop();
    }
  });
});

test('PUT validation: unknown fields, bad values, unavailable runtime location', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const put = (b: unknown) => server.request('PUT', `${base}/settings`, b);
      assert.equal((await put({ nonsense: 1 })).status, 400);
      assert.equal((await put({ airGapped: 'yes' })).status, 400);
      assert.equal((await put({ region: 'mars' })).status, 400);
      assert.equal((await put({ model: { primary: { provider: 'skynet', model: 'x' } } })).status, 400);
      assert.equal((await put({ model: { primary: { provider: 'openai', model: 'has space' } } })).status, 400);
      assert.equal((await put({ trust: { requireCompilerAttestation: true } })).status, 400);
      assert.equal(
        (await put({ runtime: { location: 'cloud' } })).status,
        412,
        'a location the deployment does not offer is refused, not stored',
      );
      assert.equal((await put({ runtime: { location: 'moon' } })).status, 400);
      assert.equal(
        (await server.request('GET', `${base}/settings`)).json<SettingsWire>().settings.revision,
        0,
        'nothing was stored by the failed attempts',
      );
    } finally {
      await server.stop();
    }
  });
});

test('air-gapped mode refuses off-box providers whichever order the fields arrive in', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const a = await server.request('PUT', `${base}/settings`, {
        airGapped: true,
        model: { primary: { provider: 'openai', model: 'gpt' } },
      });
      assert.equal(a.status, 412);
      assert.match(a.bodyText, /air-gapped/);
      assert.equal(
        (await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'openai', model: 'gpt' } } })).status,
        200,
      );
      const b = await server.request('PUT', `${base}/settings`, { airGapped: true });
      assert.equal(b.status, 412, 'turning air-gapped on while an off-box model is selected is refused');
      assert.equal(
        (
          await server.request('PUT', `${base}/settings`, {
            airGapped: true,
            model: { primary: { provider: 'ollama', model: 'llama3' }, fallback: null },
          })
        ).status,
        200,
      );
    } finally {
      await server.stop();
    }
  });
});

test('stale expectedRevision is a 412 and changes nothing', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      assert.equal((await server.request('PUT', `${base}/settings`, { expectedRevision: 0, airGapped: true })).status, 200);
      const stale = await server.request('PUT', `${base}/settings`, { expectedRevision: 0, airGapped: false });
      assert.equal(stale.status, 412);
      assert.equal((await server.request('GET', `${base}/settings`)).json<SettingsWire>().settings.airGapped, true);
    } finally {
      await server.stop();
    }
  });
});

test('only admins can change settings; any member can read them', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const pub = await server.issueAdditionalIdentity('pub');
      await server.request('POST', `${base}/members`, { identityId: 'pub', role: 'publisher' });
      assert.equal((await server.request('GET', `${base}/settings`, undefined, TestServer.authHeader(pub.apiKey))).status, 200);
      assert.equal((await server.request('PUT', `${base}/settings`, { airGapped: true }, TestServer.authHeader(pub.apiKey))).status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('runtime status reports what the server can observe', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const res = (await server.request('GET', `${base}/runtime/status`)).json<Record<string, any>>();
      assert.equal(res['status'], 'online');
      assert.equal(res['location'], 'this_computer');
      assert.equal(res['runtime'].mountedPackages, 0);
      assert.equal(res['model'].usable, false);
      assert.ok(typeof res['server'].uptimeSeconds === 'number');
      assert.ok(res['auditHead'] !== undefined);
    } finally {
      await server.stop();
    }
  });
});

test('requireSignedPackages makes registry publish refuse an unsigned package', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      const archive = Buffer.from(await packBundle(buildFixtureBundle({ name: 'unsigned_pkg' })));
      assert.equal((await server.request('POST', `${base}/registry/packages`, archive)).status, 201, 'allowed while the setting is off');
      assert.equal((await server.request('PUT', `${base}/settings`, { trust: { requireSignedPackages: true } })).status, 200);
      const archive2 = Buffer.from(await packBundle(buildFixtureBundle({ name: 'unsigned_pkg_2' })));
      const refused = await server.request('POST', `${base}/registry/packages`, archive2);
      assert.equal(refused.status, 412);
      assert.match(refused.bodyText, /signed packages/);
    } finally {
      await server.stop();
    }
  });
});

test('notifications: derived from the audit log, filtered by settings, with a forward-only read marker', async () => {
  await withDirs(async (dirs) => {
    const { server, base } = await boot(dirs);
    try {
      // Produce a failure entry through the real compile path: upload then compile an unparseable PDF.
      const up = await server.request('POST', `${base}/sources?filename=bad.pdf`, Buffer.from('%PDF-not-really'), {
        'content-type': 'application/pdf',
      });
      assert.equal(up.status, 201, up.bodyText);
      const src = up.json<{ sourceId: string }>().sourceId;
      await server.request('POST', `${base}/sources/${src}/compile`);

      const first = (await server.request('GET', `${base}/notifications`)).json<{
        notifications: { seq: number; kind: string; read: boolean }[];
        unread: number;
      }>();
      assert.ok(first.notifications.length >= 1, 'compiling a corrupt PDF must produce a run_failure notification');
      assert.ok(first.notifications.every((n) => n.kind === 'run_failure'));
      assert.equal(first.unread, first.notifications.length);

      await server.request('PUT', `${base}/settings`, { notifications: { onRunFailure: false } });
      assert.equal((await server.request('GET', `${base}/notifications`)).json<{ notifications: unknown[] }>().notifications.length, 0);
      await server.request('PUT', `${base}/settings`, { notifications: { onRunFailure: true } });

      if (first.notifications.length > 0) {
        const top = first.notifications[0]!.seq;
        assert.equal(
          (await server.request('POST', `${base}/notifications/read`, { throughSeq: top })).json<{ readThroughSeq: number }>()
            .readThroughSeq,
          top,
        );
        assert.equal(
          (await server.request('POST', `${base}/notifications/read`, { throughSeq: 1 })).json<{ readThroughSeq: number }>().readThroughSeq,
          top,
          'marker never moves backwards',
        );
        assert.equal((await server.request('GET', `${base}/notifications`)).json<{ unread: number }>().unread, 0);
      }
      assert.equal((await server.request('POST', `${base}/notifications/read`, { throughSeq: -1 })).status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('classify: escalation / failure / completion map to the right setting', () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry =>
    ({
      seq: 1,
      eventId: 'e',
      workspaceId: 'w',
      at: 't',
      prevHash: 'p',
      hash: 'h',
      actor: { identityId: 'a', kind: 'user' },
      event: 'execution.created',
      result: 'succeeded',
      ...over,
    }) as AuditEntry;
  assert.equal(classify(entry({ result: 'escalated' }), DEFAULT_SETTINGS), 'escalation');
  assert.equal(classify(entry({ result: 'failed' }), DEFAULT_SETTINGS), 'run_failure');
  assert.equal(classify(entry({ result: 'failed', event: 'source.uploaded' }), DEFAULT_SETTINGS), undefined);
  assert.equal(
    classify(entry({ event: 'workflow.started', detail: { status: 'succeeded' } }), DEFAULT_SETTINGS),
    undefined,
    'off by default',
  );
  const on = applySettingsPatch(
    DEFAULT_SETTINGS,
    parseSettingsPatch({ notifications: { onWorkflowComplete: true } }, ['this_computer']),
    'x',
    new Date(),
  );
  assert.equal(classify(entry({ event: 'workflow.started', detail: { status: 'succeeded' } }), on), 'workflow_complete');
});
