import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import {
  BlobDispatchLedger,
  ExternalToolDispatcher,
  InMemoryDispatchLedger,
  type DispatchLedger,
  type ExternalToolAdapter,
} from '../src/index.js';

// P1.1 M4 — a dispatcher can never be built over non-durable evidence by accident.

const adapter: ExternalToolAdapter = { id: 'a', invoke: async () => ({ kind: 'confirmed_success', output: 1 }) };
const adapters = new Map([['cap', adapter]]);

test('an in-memory ledger is refused without the explicit opt-in, and nothing can be dispatched through it', () => {
  assert.throws(() => new ExternalToolDispatcher({ adapters, ledger: new InMemoryDispatchLedger() }), /durable DispatchLedger/);
});

test('a ledger that does not declare durability is treated as volatile (fail closed)', () => {
  const unlabelled: DispatchLedger = { read: () => [], readByCapability: () => [], append: () => undefined };
  assert.throws(() => new ExternalToolDispatcher({ adapters, ledger: unlabelled }), /durable DispatchLedger/);
  const lies: DispatchLedger = { ...unlabelled, durability: 'volatile' };
  assert.throws(() => new ExternalToolDispatcher({ adapters, ledger: lies }), /durable DispatchLedger/);
});

test('the explicit opt-in builds, and reports itself volatile; a durable ledger needs no opt-in and reports durable', async () => {
  const volatile = new ExternalToolDispatcher({ adapters, ledger: new InMemoryDispatchLedger(), unsafeAllowVolatileLedger: true });
  assert.equal(volatile.ledgerDurability, 'volatile');
  const dir = await mkdtemp(join(tmpdir(), 'xo-guard-'));
  try {
    const durable = new ExternalToolDispatcher({ adapters, ledger: new BlobDispatchLedger(new LocalFsBlobStore(dir)) });
    assert.equal(durable.ledgerDurability, 'durable');
    assert.equal((await durable.dispatch('cap', 'k', {})).kind, 'confirmed_success');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the opt-in cannot make an unlabelled ledger look durable', () => {
  const unlabelled: DispatchLedger = { read: () => [], readByCapability: () => [], append: () => undefined };
  assert.equal(new ExternalToolDispatcher({ adapters, ledger: unlabelled, unsafeAllowVolatileLedger: true }).ledgerDurability, 'volatile');
});
