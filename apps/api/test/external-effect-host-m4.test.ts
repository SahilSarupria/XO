import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import { NonProductionAuditSink } from '@xo/audit';
import type { CapabilityInputSchema } from '@xo/types';
import { ExternalToolDispatcher, InMemoryDispatchLedger, type ExternalToolAdapter } from '@xo/adapters';
import { createDurableExternalToolWiring, createExternalToolWiring } from '@xo/runtime';
import { buildRouter } from '../src/server.js';
import { PackageTrustPolicy } from '@xo/package-sdk';

// P1.1 M4 — the host boundary: external tools over volatile evidence are refused at startup in production; the supported factory is durable.
// The API entrypoint (src/index.ts) does not enable external tools at all: only an embedding host passes `externalTools`.

const SCHEMA: CapabilityInputSchema = { type: 'object', properties: {}, required: [] };
const adapter: ExternalToolAdapter = {
  id: 'a',
  approvalMode: 'definition',
  invoke: async () => ({ kind: 'confirmed_success', output: 1 }),
};

async function inProduction<T>(fn: () => T | Promise<T>): Promise<T> {
  const prior = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prior;
  }
}

test('production startup REFUSES external tools over a volatile (opted-in in-memory) ledger', async () => {
  const volatile = createExternalToolWiring(
    new ExternalToolDispatcher({
      adapters: new Map([['cap', adapter]]),
      ledger: new InMemoryDispatchLedger(),
      unsafeAllowVolatileLedger: true,
    }),
    new Map([['cap', SCHEMA]]),
  );
  await inProduction(() => {
    assert.throws(
      () =>
        buildRouter({
          externalTools: volatile,
          auditSink: new NonProductionAuditSink(),
          packageTrustPolicy: PackageTrustPolicy.development(),
        }),
      (e: unknown) =>
        e instanceof XoError && e.code === ErrorCode.CONFIG_INVALID_VALUE && /durable dispatch-evidence ledger/.test(e.message),
    );
  });
});

test('production startup does not trip the ledger guard for a durable wiring (any other failure is a different, unrelated check)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-host-'));
  try {
    const durable = createDurableExternalToolWiring({
      adapters: new Map([['cap', adapter]]),
      inputSchemas: new Map([['cap', SCHEMA]]),
      evidenceStore: new LocalFsBlobStore(dir),
    });
    await inProduction(() => {
      try {
        buildRouter({
          externalTools: durable,
          auditSink: new NonProductionAuditSink(),
          packageTrustPolicy: PackageTrustPolicy.development(),
        });
      } catch (e) {
        assert.ok(
          !(e instanceof Error) || !/durable dispatch-evidence ledger/.test(e.message),
          'the ledger guard must not fire for a durable wiring',
        );
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outside production a volatile wiring is still allowed (tests/local), and the default server has no external tools at all', () => {
  const volatile = createExternalToolWiring(
    new ExternalToolDispatcher({
      adapters: new Map([['cap', adapter]]),
      ledger: new InMemoryDispatchLedger(),
      unsafeAllowVolatileLedger: true,
    }),
    new Map([['cap', SCHEMA]]),
  );
  assert.doesNotThrow(() =>
    buildRouter({ externalTools: volatile, auditSink: new NonProductionAuditSink(), packageTrustPolicy: PackageTrustPolicy.development() }),
  );
  assert.doesNotThrow(() => buildRouter({ auditSink: new NonProductionAuditSink(), packageTrustPolicy: PackageTrustPolicy.development() }));
});
