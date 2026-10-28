/**
 * C1 acceptance gate 1: the SAME contract suite passes for two connectors - the real local filesystem connector and an honest
 * mock. See `support/connector-contract.ts` for what is asserted.
 */
import { join } from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ConnectorRegistry, EnvironmentInventory, FILESYSTEM_CONNECTOR_ID, LocalFilesystemConnector } from '../src/index.js';
import { defineConnectorContract } from './support/connector-contract.js';
import { MOCK_CONNECTOR_ID, MOCK_SOURCE_TYPE, MockConnector } from './support/mock-connector.js';
import { put } from './helpers.js';

defineConnectorContract('filesystem', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-ei-c1-')));
  const root = join(base, 'approved');
  await put(join(root, 'INV-1001.txt'), 'Invoice INV-1001 total 10');
  await put(join(root, 'notes.md'), 'meeting notes');
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  return {
    deps: { registry, inventory: new EnvironmentInventory() },
    connectorId: FILESYSTEM_CONNECTOR_ID,
    sourceType: 'local_filesystem',
    scope: { kind: 'filesystem_root', root },
    readKeys: ['INV-1001.txt', 'notes.md'],
    supportsSync: false,
    supportsHealth: false,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
});

defineConnectorContract('mock', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new MockConnector());
  return {
    deps: { registry, inventory: new EnvironmentInventory() },
    connectorId: MOCK_CONNECTOR_ID,
    sourceType: MOCK_SOURCE_TYPE,
    scope: { kind: 'mock_source', path: '/mock/alpha' },
    readKeys: ['a.txt', 'b.txt'],
    supportsSync: true,
    supportsHealth: true,
    cleanup: async () => undefined,
  };
});
