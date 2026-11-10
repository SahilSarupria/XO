import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import type { CapabilityInputSchema } from '@xo/types';
import { BlobDispatchLedger, ExternalToolDispatcher, InMemoryDispatchLedger, type ExternalToolAdapter } from '@xo/adapters';
import { createDurableExternalToolWiring, createExternalToolWiring } from '../src/index.js';

// P1.1 M4 — the supported host construction path is durable by construction; an in-memory wiring is visibly volatile.

const SCHEMA: CapabilityInputSchema = { type: 'object', properties: {}, required: [] };
const adapter: ExternalToolAdapter = {
  id: 'a',
  approvalMode: 'definition',
  invoke: async () => ({ kind: 'confirmed_success', output: 1 }),
};

test('createDurableExternalToolWiring: durable, evidence lands in the supplied store and survives a rebuilt wiring (restart)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-rt-durable-'));
  try {
    const build = () =>
      createDurableExternalToolWiring({
        adapters: new Map([['cap', adapter]]),
        inputSchemas: new Map([['cap', SCHEMA]]),
        evidenceStore: new LocalFsBlobStore(dir),
      });
    const first = build();
    assert.equal(first.ledgerDurability, 'durable');
    assert.equal(first.describe('cap')?.adapterId, 'a');
    // Reconciliation of a key with no evidence is "not found" (absence of evidence is not proof), proving the ledger is the store's.
    const missing = await first.reconcile({
      dispatchKey: 'k',
      actor: { kind: 'human', id: 'h' },
      decision: 'unresolved',
      reason: 'r',
      evidenceExamined: '',
    });
    assert.equal(missing.kind, 'not_found');
    assert.equal((await first.evidenceFor('k')).length, 0);
    const dispatcher = new ExternalToolDispatcher({
      adapters: new Map([['cap', adapter]]),
      ledger: new BlobDispatchLedger(new LocalFsBlobStore(dir)),
    });
    await dispatcher.dispatch('cap', 'k', {});
    assert.deepEqual(
      (await build().evidenceFor('k')).map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
    assert.ok((await readdir(join(dir, 'external-effects'))).includes('events'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createDurableExternalToolWiring refuses a missing evidence store (fail closed, no default)', () => {
  assert.throws(
    () =>
      createDurableExternalToolWiring({
        adapters: new Map([['cap', adapter]]),
        inputSchemas: new Map([['cap', SCHEMA]]),
        evidenceStore: undefined as never,
      }),
    /durable evidence store/,
  );
});

test('a wiring built over an opted-in in-memory ledger reports volatile (so the server can refuse it in production)', () => {
  const dispatcher = new ExternalToolDispatcher({
    adapters: new Map([['cap', adapter]]),
    ledger: new InMemoryDispatchLedger(),
    unsafeAllowVolatileLedger: true,
  });
  assert.equal(createExternalToolWiring(dispatcher, new Map([['cap', SCHEMA]])).ledgerDurability, 'volatile');
});
