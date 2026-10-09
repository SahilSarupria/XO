import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packBundle } from '@xo/package-sdk';
import { capabilitiesCommand } from '../src/commands/compiler/capabilities.js';
import { buildTestBundle, echoCapability, withTempDir } from './helpers.js';

const OBLIGATION_TEXT = 'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n' + 'The team shall generate a summary report weekly and deliver it to the Client.\n';

/**
 * The real benchmark fixture (`examples/vertical-test/`) — used below for
 * the one test that needs a genuinely resolvable capability. Plain
 * obligation-style text (like `OBLIGATION_TEXT` above) has no numeric
 * threshold/decision-table structure for the compiler's
 * `StructuredComparisonBindingResolver` to resolve against, so every
 * capability it discovers is legitimately `unresolved` — that is real,
 * current compiler behavior (see the assertions below), not something
 * this file works around. Proving `resolvedCount > 0` actually flows
 * through requires a source with real decision-rule content, which this
 * fixture has.
 */
const REAL_FIXTURE_PATH = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));

test('capabilities on a source file with no resolvable decision structure lists DISCOVERED capabilities and truthfully reports 0 resolved, with a real reason per capability', async () => {
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');

    const result = await capabilitiesCommand({ target: path, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.mode, 'source');
    assert.ok(parsed.discovered.length > 0);
    assert.equal(parsed.resolvedCount, 0);
    // Every discovered capability's non-resolution is accounted for by a
    // real `LoweredCapabilityOutcome`, not silently asserted — this is
    // what "truthful" means here: the CLI never claims a number it
    // didn't get from actually running the Packager.
    assert.equal(parsed.outcomes.length, parsed.discovered.length);
    for (const outcome of parsed.outcomes) {
      assert.notEqual(outcome.status, 'resolved');
      assert.ok(outcome.reason.length > 0);
    }

    const textResult = await capabilitiesCommand({ target: path });
    const output = textResult.lines.join('\n');
    assert.match(output, /Discovered capabilities \(XOIR "capability" nodes\): \d+/);
    assert.match(output, /Resolved capabilities \(would lower into manifest-level CapabilityDeclaration if packaged\): 0/);
    // Must NOT claim the lowering mechanism itself doesn't exist — it does.
    assert.doesNotMatch(output, /lowering step does not exist|does not exist in this compiler/);
  });
});

test('capabilities on a source with real decision-rule content (the vertical-test benchmark fixture) reports the actual nonzero resolved count', async () => {
  const result = await capabilitiesCommand({ target: REAL_FIXTURE_PATH, json: true });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.lines[0]!);
  assert.equal(parsed.mode, 'source');
  // Pinned to the known-current values from the real compiler (23
  // discovered / 15 resolved) so a regression in either the compiler's
  // discovery/lowering or this command's plumbing is caught — if the
  // compiler's own extraction quality legitimately changes these
  // numbers, this assertion is expected to need updating alongside it,
  // not a sign the CLI is wrong.
  assert.equal(parsed.discovered.length, 23);
  assert.equal(parsed.resolvedCount, 15);
  assert.ok(parsed.resolvedCount > 0, 'this fixture must prove the positive case, not just 0-resolved');
  assert.ok(parsed.resolvedCount < parsed.discovered.length, 'this fixture must also prove some discovered capabilities remain unresolved, not conflate the two counts');
});

test('capabilities --json on a source reports a discovered array and a real resolvedCount/outcomes pair', async () => {
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');

    const result = await capabilitiesCommand({ target: path, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.mode, 'source');
    assert.ok(Array.isArray(parsed.discovered));
    assert.equal(typeof parsed.resolvedCount, 'number');
    assert.ok(Array.isArray(parsed.outcomes));
  });
});

test('capabilities on a .xo archive with no declared capabilities reports 0 resolved and explains why, without claiming the lowering mechanism is absent', async () => {
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const bundle = buildTestBundle({ capabilities: [] });
    const bytes = await packBundle(bundle);
    const archivePath = join(tmp, 'empty.xo');
    await writeFile(archivePath, bytes);

    const result = await capabilitiesCommand({ target: archivePath });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Resolved capabilities \(manifest\.capabilities\): 0/);
    assert.doesNotMatch(output, /lowering step does not exist yet/);
  });
});

test('capabilities on a .xo archive with declared capabilities lists them as RESOLVED', async () => {
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const bundle = buildTestBundle({ capabilities: [echoCapability] });
    const bytes = await packBundle(bundle);
    const archivePath = join(tmp, 'with-caps.xo');
    await writeFile(archivePath, bytes);

    const result = await capabilitiesCommand({ target: archivePath, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.mode, 'archive');
    assert.equal(parsed.resolved.length, 1);
    assert.equal(parsed.resolved[0].id, 'echo');
  });
});

test('capabilities on a nonexistent .xo file fails with a read error, not a crash', async () => {
  const result = await capabilitiesCommand({ target: '/nonexistent/does-not-exist.xo' });
  assert.equal(result.exitCode, 1);
});

test('capabilities on a directory of sources merges them before discovery and lists which files were compiled', async () => {
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const dir = join(tmp, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), OBLIGATION_TEXT, 'utf8');
    await writeFile(join(dir, 'b.txt'), 'The team shall generate a summary report weekly and deliver it to the Client.', 'utf8');

    const result = await capabilitiesCommand({ target: dir, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.mode, 'source');
    assert.deepEqual(parsed.discoveredSources.sort(), ['a.txt', 'b.txt']);
  });
});

test('capabilities on a .zip of sources discovers capabilities across the merged compilation', async (t) => {
  let AdmZip: new () => { addFile(name: string, data: Buffer): void; toBuffer(): Buffer };
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch {
    t.skip('adm-zip is not installed in this environment');
    return;
  }
  await withTempDir('xo-capabilities-test-', async (tmp) => {
    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from(OBLIGATION_TEXT));
    const zipPath = join(tmp, 'docs.zip');
    await writeFile(zipPath, zip.toBuffer());

    const result = await capabilitiesCommand({ target: zipPath, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.mode, 'source');
    assert.deepEqual(parsed.discoveredSources, ['a.txt']);
  });
});
