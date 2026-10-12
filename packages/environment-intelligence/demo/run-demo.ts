/* eslint-disable no-console -- developer demo prints to stdout */
/**
 * Reproducible developer demo. Run: npm run demo -w @xo/environment-intelligence
 *
 * Part 1 scans a REAL directory (this package's own source, read-only, bounded).
 *         It is a developer demo, NOT customer data.
 * Part 2 scans a COPY of the synthetic invoice fixture (origin: test_fixture).
 * The authorization used is the DEVELOPMENT-ONLY operator allow-list; it is not
 * the P1.0 gate and every record says so.
 */
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import {
  FileAuditLog,
  verifyAuditLog,
  ConnectorRegistry,
  DevelopmentOperatorAuthorization,
  EnvironmentInventory,
  LocalFilesystemConnector,
  acquireSourceContent,
  buildEnvironmentModel,
  discoverSource,
  explainEnvironment,
  type Clock,
  type Evidence,
  type FilesystemScope,
  type ModelOrigin,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clock: Clock = { now: () => new Date() };
// M2.1: every protected operation needs an AUTHENTICATED principal. A real deployment receives one from its
// authentication boundary; this demo mints a clearly-labelled development operator the way that boundary would.
const demoOperator = establishAuthenticatedPrincipal({ kind: 'human', id: 'demo-operator' });
if (!demoOperator.ok) throw new Error('demo principal could not be established');

async function run(title: string, root: string, origin: ModelOrigin): Promise<void> {
  console.log(`\n=== ${title} ===`);
  // M4: protected evidence operations are audited write-ahead into a DURABLE append-only log (demo: a temp dir).
  const auditDir = await mkdtemp(join(tmpdir(), 'xo-ei-audit-'));
  const opened = await FileAuditLog.open({ dir: auditDir });
  if (!opened.ok) {
    await rm(auditDir, { recursive: true, force: true });
    return void console.log('audit log unavailable; refusing to run unaudited:', opened.error.code);
  }
  const auditLog = opened.value;
  try {
    const registry = new ConnectorRegistry();
    registry.register(new LocalFilesystemConnector());
    const deps = { registry, inventory: new EnvironmentInventory() };
    const scope: FilesystemScope = { kind: 'filesystem_root', root, limits: { maxDepth: 4, maxEntries: 500 } };
    const ctx = {
      clock,
      principal: demoOperator.value,
      // M2.2: protected evidence operations are refused without a recorder. In-memory = DEMO ONLY (non-durable).
      audit: auditLog,
      authorization: new DevelopmentOperatorAuthorization([
        { permission: 'filesystem.list', path: root },
        { permission: 'filesystem.read', path: root },
      ]),
    };
    const d = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
    if (!d.ok) return void console.log('discovery refused:', d.error.code, d.error.message);
    const evidence: Evidence[] = [...d.value.evidence];
    const keys = evidence
      .filter((e) => e.kind === 'resource_inventory' && e.payload['contentAcquirable'] === true)
      .map((e) => e.resourceKey);
    const a = await acquireSourceContent(
      deps,
      { sourceId: d.value.record.source.sourceId, kind: 'document_content', resourceKeys: keys, scope },
      ctx,
    );
    if (a.ok) evidence.push(...a.value.evidence);
    else console.log('acquisition refused:', a.error.code);
    console.log('inventory states:', JSON.stringify(deps.inventory.countsByStatus()));
    console.log('evidence records:', evidence.length);
    const model = buildEnvironmentModel({ origin, generatedAt: clock.now().toISOString(), inventory: deps.inventory, evidence });
    console.log(explainEnvironment(model));
  } finally {
    await auditLog.close();
    const report = await verifyAuditLog(auditDir);
    if (report.ok)
      console.log(
        `audit log: ${report.value.events} events, verified=${report.value.ok}, open attempts=${report.value.openAttempts.length}`,
      );
    await rm(auditDir, { recursive: true, force: true });
  }
}

const real = await realpath(join(here, '..', 'src'));
await run('Part 1: real bounded scan (developer demo, not customer data)', real, 'live_discovery');

const tmp = await realpath(await mkdtemp(join(tmpdir(), 'xo-ei-demo-')));
try {
  await cp(join(here, '..', 'fixtures', 'invoices'), tmp, { recursive: true });
  await run('Part 2: SYNTHETIC FIXTURE (test_fixture, not a customer environment)', tmp, 'test_fixture');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
