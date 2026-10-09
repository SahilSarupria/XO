import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle } from '@xo/package-sdk';
import { verifyCommand } from '../src/commands/package/verify.js';
import { withTempDir, buildTestBundle } from './helpers.js';

async function writeArchive(dir: string, filename = 'pkg.xo'): Promise<string> {
  const bundle = buildTestBundle();
  const bytes = await packBundle(bundle);
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

test('verify prints PASS for every check on a well-formed unsigned package and exits 0', async () => {
  await withTempDir('xo-verify-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const result = await verifyCommand({ archivePath });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /\[PASS\] schema/);
    assert.match(output, /\[PASS\] hashes/);
    assert.match(output, /\[PASS\] merkle_root/);
    assert.match(output, /\[PASS\] required_components/);
    assert.match(output, /\[PASS\] signature/);
    assert.match(output, /VALID$/);
  });
});

test('verify on a truncated/corrupt archive fails clearly with a non-zero exit code', async () => {
  await withTempDir('xo-verify-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const bytes = await readFile(archivePath);
    await writeFile(archivePath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));

    const result = await verifyCommand({ archivePath });
    assert.equal(result.exitCode, 1);
  });
});

test('verify on a nonexistent file fails with a read error, not a crash', async () => {
  const result = await verifyCommand({ archivePath: '/nonexistent/pkg.xo' });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /could not read/);
});

test('verify rejects a malformed --pubkey spec before touching the archive', async () => {
  const result = await verifyCommand({ archivePath: '/does/not/matter.xo', pubkeySpecs: ['no-equals-sign-here'] });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /expected "<did>=<path\/to\/key\.pem>"/);
});

test('verify reports [WARN] signature (not FAIL) when signatures are present but no --pubkey was supplied', async () => {
  await withTempDir('xo-verify-test-', async (dir) => {
    const { Ed25519Signer } = await import('@xo/crypto');
    const { ManifestBuilder, PackageSigner } = await import('@xo/package-sdk');
    const { testCompatibility, echoCapability } = await import('./helpers.js');

    const builder = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'xo_cli_signed_fixture', version: '1.0.0', creatorDid: 'did:xo:cli-test' })
      .setCompatibility(testCompatibility)
      .setMetadata({ domain: 'testing', description: 'CLI test fixture package', scope: ['testing'], limitations: [] })
      .setCapabilities([echoCapability])
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode('{"nodes":[],"edges":[]}'), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true });

    const unsigned = builder.build();
    assert.ok(unsigned.ok);

    const signer = new Ed25519Signer();
    const keyPair = signer.generateKeyPair();
    const entry = new PackageSigner(signer).sign(unsigned.value.manifest, 'did:xo:verify-test-signer', 'creator', keyPair.privateKey, keyPair.publicKey);

    const signed = builder.addSignature(entry).build();
    assert.ok(signed.ok);

    const bytes = await packBundle(signed.value);
    const archivePath = join(dir, 'signed.xo');
    await writeFile(archivePath, bytes);

    const result = await verifyCommand({ archivePath });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /\[WARN\] signature/);
  });
});
