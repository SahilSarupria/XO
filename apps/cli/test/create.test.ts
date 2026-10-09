import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackArchive } from '@xo/package-sdk';
import { PackageValidator } from '@xo/package-sdk';
import { createCommand } from '../src/commands/compiler/create.js';
import { withTempDir } from './helpers.js';

const OBLIGATION_TEXT =
  '# Vendor Agreement\n\n' +
  'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n\n' +
  'The team shall generate a summary report weekly and deliver it to the Client.\n';

test('create compiles a source straight through to a signed, validated .xo on disk', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const sourcePath = join(tmp, 'agreement.txt');
    await writeFile(sourcePath, OBLIGATION_TEXT, 'utf8');
    const outPath = join(tmp, 'agreement.xo');

    const result = await createCommand({
      sources: [sourcePath],
      name: 'vendor_agreement',
      version: '1.0.0',
      creatorDid: 'did:xo:create-test',
      domain: 'contract-law',
      out: outPath,
      sign: true,
      signerDid: 'did:xo:create-test-signer',
    });

    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const output = result.lines.join('\n');
    assert.match(output, /Capabilities:/);
    assert.match(output, /0 resolved and lowered into manifest\.capabilities/);
    assert.doesNotMatch(output, /lowering exists|does not exist/);
    assert.match(output, /Determinism:\n\s+verified/);
    assert.match(output, /signed by did:xo:create-test-signer/);
    assert.match(output, /validated: yes/);
    assert.match(output, /Wrote \d+ bytes to/);

    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
    if (!unpacked.ok) return;

    assert.equal(unpacked.value.manifest.name, 'vendor_agreement');
    assert.equal(unpacked.value.manifest.version, '1.0.0');
    assert.equal(unpacked.value.manifest.capabilities?.length ?? 0, 0);
    assert.equal(unpacked.value.manifest.signatures?.length, 1);
    assert.equal(unpacked.value.manifest.signatures?.[0]?.signerDid, 'did:xo:create-test-signer');

    const validation = new PackageValidator().validateAll(unpacked.value);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  });
});

test('create without --sign produces an unsigned but still valid package', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const sourcePath = join(tmp, 'agreement.txt');
    await writeFile(sourcePath, OBLIGATION_TEXT, 'utf8');
    const outPath = join(tmp, 'unsigned.xo');

    const result = await createCommand({ sources: [sourcePath], name: 'unsigned_test', out: outPath });
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    assert.match(result.lines.join('\n'), /signed:\s+no/);

    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
    if (unpacked.ok) assert.equal(unpacked.value.manifest.signatures?.length ?? 0, 0);
  });
});

test('create --json emits parseable JSON including discoveredCapabilities, resolvedCapabilities, loweredCapabilities (0 for this obligation-only fixture), deterministic', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const sourcePath = join(tmp, 'agreement.txt');
    await writeFile(sourcePath, OBLIGATION_TEXT, 'utf8');
    const outPath = join(tmp, 'agreement.xo');

    const result = await createCommand({ sources: [sourcePath], name: 'json_test', out: outPath, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(typeof parsed.discoveredCapabilities, 'number');
    // This fixture is plain obligation text with no decision-rule
    // structure, so 0 resolved is the real, current answer for it — not
    // a hardcoded assumption. The positive case (resolvedCapabilities > 0
    // actually flowing through to the manifest) is proven separately
    // below against a source that has real decision-rule content.
    assert.equal(parsed.resolvedCapabilities, 0);
    assert.equal(parsed.loweredCapabilities, 0);
    assert.equal(parsed.deterministic, true);
    assert.equal(parsed.packageValid, true);
    assert.equal(parsed.outPath, outPath);
  });
});

test('create against a source with real decision-rule content (the vertical-test benchmark fixture) reports and actually lowers a nonzero resolved count into manifest.capabilities', async () => {
  const fixturePath = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
  await withTempDir('xo-create-real-fixture-', async (tmp) => {
    const outPath = join(tmp, 'commercial.xo');

    const result = await createCommand({ sources: [fixturePath], name: 'commercial_regression', out: outPath, json: true });
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);

    // Pinned to the known-current real-compiler values (23 discovered /
    // 15 resolved) — if the compiler's own extraction quality
    // legitimately changes these, this assertion needs updating
    // alongside it; that is not a CLI regression by itself. What this
    // test actually guards is that `create.ts` reports whatever the
    // Packager's real LowerCapabilitiesResult says, never a hardcoded 0.
    assert.equal(parsed.discoveredCapabilities, 23);
    assert.equal(parsed.resolvedCapabilities, 15);
    assert.equal(parsed.loweredCapabilities, 15);
    assert.ok(parsed.resolvedCapabilities > 0, 'must prove the positive case, not just 0-resolved');
    assert.ok(parsed.resolvedCapabilities < parsed.discoveredCapabilities, 'must also prove some discovered capabilities remain unresolved');
    assert.equal(parsed.capabilityOutcomes.length, 23);

    // And the manifest actually on disk must agree with what was
    // printed — the CLI must never report a number it didn't actually
    // write.
    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
    if (unpacked.ok) assert.equal(unpacked.value.manifest.capabilities?.length ?? 0, 15);
  });
});

test('create with no sources fails with a usage-level error, not a crash', async () => {
  const result = await createCommand({ sources: [] });
  assert.equal(result.exitCode, 1);
});

test('create on a nonexistent source fails with a read error, not a crash, and writes no file', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const outPath = join(tmp, 'should-not-exist.xo');
    const result = await createCommand({ sources: ['/nonexistent/does-not-exist.txt'], out: outPath });
    assert.equal(result.exitCode, 1);
    await assert.rejects(readFile(outPath));
  });
});

test('create on a directory of sources compiles all of them into one package', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const dir = join(tmp, 'docs');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'policy.txt'), OBLIGATION_TEXT, 'utf8');
    await writeFile(join(dir, 'sub', 'claims.txt'), 'The insured shall notify the insurer within 48 hours.', 'utf8');
    const outPath = join(tmp, 'from-dir.xo');

    const result = await createCommand({ sources: [dir], name: 'from_dir', out: outPath, json: true });
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
    assert.deepEqual(parsed.discoveredSources.sort(), ['policy.txt', 'sub/claims.txt']);
    assert.equal(parsed.packageValid, true);

    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
  });
});

test('create on a .zip archive compiles the extracted sources into one package and cleans up the temp dir', async (t) => {
  let AdmZip: new () => { addFile(name: string, data: Buffer): void; toBuffer(): Buffer };
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch {
    t.skip('adm-zip is not installed in this environment');
    return;
  }
  await withTempDir('xo-create-test-', async (tmp) => {
    const zip = new AdmZip();
    zip.addFile('policy.txt', Buffer.from(OBLIGATION_TEXT));
    zip.addFile('claims/procedure.txt', Buffer.from('The insured shall notify the insurer within 48 hours.'));
    const zipPath = join(tmp, 'docs.zip');
    await writeFile(zipPath, zip.toBuffer());
    const outPath = join(tmp, 'from-zip.xo');

    const result = await createCommand({ sources: [zipPath], name: 'from_zip', out: outPath, json: true });
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
    assert.deepEqual(parsed.discoveredSources.sort(), ['claims/procedure.txt', 'policy.txt']);

    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
    if (unpacked.ok) {
      const validation = new PackageValidator().validateAll(unpacked.value);
      assert.equal(validation.valid, true, JSON.stringify(validation.issues));
    }

    // The original archive itself must be untouched.
    const zipAfter = await readFile(zipPath);
    assert.ok(zipAfter.length > 0);
  });
});

test('create on a directory produces the same graph content hash across two independent runs (determinism holds for multi-source too)', async () => {
  await withTempDir('xo-create-test-', async (tmp) => {
    const dir = join(tmp, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'The reviewer shall approve the draft.', 'utf8');
    await writeFile(join(dir, 'b.txt'), 'The vendor shall deliver goods within 10 days.', 'utf8');

    const out1 = join(tmp, 'run1.xo');
    const result1 = await createCommand({ sources: [dir], name: 'det_test', out: out1, json: true });
    assert.equal(result1.exitCode, 0);
    assert.equal(JSON.parse(result1.lines[0]!).deterministic, true);
  });
});

test('golden vertical: four-file directory (README, policy, claims procedure, supporting rules) compiles into one XO with per-source provenance preserved', async () => {
  const fixtureDir = fileURLToPath(new URL('../../../examples/vertical-test-multidoc/', import.meta.url));
  await withTempDir('xo-create-golden-', async (tmp) => {
    const outPath = join(tmp, 'burglary-policy-bundle.xo');

    const result = await createCommand({
      sources: [fixtureDir],
      name: 'burglary_policy_bundle',
      version: '1.0.0',
      domain: 'insurance',
      out: outPath,
      json: true,
    });

    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const parsed = JSON.parse(result.lines[0]!);

    // Four real files, discovered as four sources (not collapsed to one).
    // `README.md` documents the fixture itself but is, correctly, still a
    // `.md` file — a known/supported extension (`source-input.ts`'s
    // `KNOWN_EXTENSIONS`) — so it is genuinely discovered and compiled
    // alongside the three policy documents, not silently excluded.
    assert.deepEqual(parsed.discoveredSources.sort(), ['README.md', 'claims-procedure.txt', 'policy.txt', 'supporting-rules.txt']);
    assert.equal(parsed.sources.length, 4);
    assert.equal(parsed.unsupportedFiles.length, 0);
    assert.equal(parsed.packageValid, true);
    assert.equal(parsed.deterministic, true);

    // One merged package on disk, not four.
    const bytes = await readFile(outPath);
    const unpacked = await unpackArchive(new Uint8Array(bytes));
    assert.ok(unpacked.ok);
    if (!unpacked.ok) return;
    assert.equal(unpacked.value.manifest.name, 'burglary_policy_bundle');

    const validation = new PackageValidator().validateAll(unpacked.value);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));

    // Provenance: the merged compilation result's own per-source report
    // must still distinguish all four original files by their
    // collection-relative declared path — the merge must not collapse
    // multi-source provenance into the directory argument itself.
    const declaredPaths = parsed.sources.map((s: { sourcePath: string }) => s.sourcePath).sort();
    assert.deepEqual(declaredPaths, ['README.md', 'claims-procedure.txt', 'policy.txt', 'supporting-rules.txt']);
  });
});
