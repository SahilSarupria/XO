import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectBundle, inspectCompatibilityMatrix } from '../src/inspect/package-inspector.js';
import { buildSampleBundle } from './fixtures.js';

test('inspectBundle summarizes name, version, fingerprint, and per-component sizes/hashes', () => {
  const bundle = buildSampleBundle();
  const summary = inspectBundle(bundle);
  assert.equal(summary.name, bundle.manifest.name);
  assert.equal(summary.version, bundle.manifest.version);
  assert.equal(summary.components.length, bundle.components.length);
  assert.equal(
    summary.totalComponentBytes,
    bundle.components.reduce((sum, c) => sum + c.data.byteLength, 0),
  );
  assert.match(summary.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(summary.declaredFamilies, ['claude', 'generic']);
});

test('inspectCompatibilityMatrix resolves each supplied host independently', () => {
  const bundle = buildSampleBundle();
  const matrix = inspectCompatibilityMatrix(bundle, [
    { family: 'claude', capabilities: ['chat', 'tool_use'] },
    { family: 'generic', capabilities: ['chat'] },
    { family: 'unknown_family', capabilities: [] },
  ]);
  assert.equal(matrix.get('claude')?.reachedLevel, 'L1');
  assert.equal(matrix.get('generic')?.reachedLevel, 'L1');
  assert.equal(matrix.get('unknown_family')?.reachedLevel, 'L0');
});
