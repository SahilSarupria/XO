/** Shared fixtures for the C0.4 hardening tests (kept separate so state-journal.test.ts stays untouched). */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFileOps, CHAIN_LOG_FILE, type FileOps } from '@xo/audit';
import {
  ConnectorId,
  EnvironmentInventory,
  EiStateStore,
  EvidenceId,
  EvidenceLedger,
  SourceId,
  type AuditTrust,
  type DetectedSource,
  type Evidence,
} from '../../src/index.js';
import { TEST_PRINCIPAL } from '../helpers.js';
import { readGrant } from './audit-grants.js';

export const T = '2026-10-12T00:00:00.000Z';
export const trust: AuditTrust = { principal: TEST_PRINCIPAL };
export const hex = (c: string, n: number): string => c.repeat(n).slice(0, n);
export const SRC = 'src_' + hex('a', 24);
export const SRC2 = 'src_' + hex('b', 24);

export const ev = (n: number, sourceId = SRC): Evidence =>
  ({
    id: EvidenceId(`ev_${String(n).padStart(24, '0')}`),
    kind: 'resource_inventory',
    sourceId: SourceId(sourceId),
    resourceKey: '',
    payload: {},
    sensitivity: 'metadata',
    provenance: {
      sourceId: SourceId(sourceId),
      connectorId: ConnectorId('xo.local-filesystem'),
      connectorVersion: '1',
      locator: '',
      observedAt: T,
      access: { operation: 'discover', permission: 'filesystem.list', authority: 'platform', decisionReason: 'test' },
      transformationChain: [],
    },
  }) as unknown as Evidence;

export const source = (sourceId = SRC): DetectedSource => ({
  sourceId: SourceId(sourceId),
  sourceType: 'local_filesystem',
  displayName: 'Quarterly Finance Share',
  locator: '/home/alice/secret-project/finance',
  detectedBy: ConnectorId('xo.local-filesystem'),
  detectedAt: T,
  fingerprint: hex('c', 64),
});

export interface Booted {
  store: EiStateStore;
  inventory: EnvironmentInventory;
  ledger: EvidenceLedger;
  started: Awaited<ReturnType<EiStateStore['start']>>;
}

export async function boot(
  dir: string,
  over: Partial<Parameters<typeof EiStateStore.open>[0]> = {},
  audit?: Parameters<EiStateStore['start']>[0]['audit'],
): Promise<Booted> {
  const opened = await EiStateStore.open({ dir, ...over });
  if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({
    grant: await readGrant(),
    trust,
    inventory,
    ledger,
    ...(audit !== undefined ? { audit } : {}),
  });
  return { store: opened.value, inventory, ledger, started };
}

export function seed(b: Pick<Booted, 'inventory'>, sourceId = SRC): void {
  b.inventory.observe(source(sourceId), T);
  b.inventory.apply(SourceId(sourceId), 'connector_matched', T, { connectorId: ConnectorId('xo.local-filesystem') });
  b.inventory.apply(SourceId(sourceId), 'connection_configured', T);
  b.inventory.apply(SourceId(sourceId), 'authorization_granted', T);
  b.inventory.apply(SourceId(sourceId), 'connection_validated', T);
  b.inventory.apply(SourceId(sourceId), 'acquisition_succeeded', T);
}

export const raw = (dir: string): Promise<string> => readFile(join(dir, CHAIN_LOG_FILE), 'utf8');

/** `failWrite`: throw BEFORE any byte lands. `failSync`: bytes land, then the fsync fails (indeterminate). */
export function faultOps(match: (line: string) => boolean, mode: 'failWrite' | 'failSync'): FileOps {
  const wrap = (h: Awaited<ReturnType<FileOps['openAppend']>>) => {
    let last = '';
    return {
      write: async (d: Buffer) => {
        last = d.toString();
        if (mode === 'failWrite' && match(last)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        await h.write(d);
      },
      sync: async () => {
        if (mode === 'failSync' && match(last)) throw Object.assign(new Error('fsync'), { code: 'EIO' });
        await h.sync();
      },
      close: () => h.close(),
    };
  };
  return {
    ...defaultFileOps,
    openAppend: async (p) => wrap(await defaultFileOps.openAppend(p)),
    openNew: async (p) => wrap(await defaultFileOps.openNew(p)),
  };
}
export const recIs =
  (rec: string) =>
  (line: string): boolean =>
    line.includes(`"rec":"${rec}"`);
export const lineHas =
  (needle: string) =>
  (line: string): boolean =>
    line.includes(needle);
