import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageInstaller } from '../src/install/package-installer.js';
import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import { packBundle } from '../src/archive/package-writer.js';
import { unpackArchive } from '../src/archive/package-reader.js';
import { PackageValidator } from '../src/validation/package-validator.js';
import { isXoManifest } from '../src/validation/schema.js';
import type { PackageBundle } from '../src/types.js';
import { buildSampleBundle, sampleCompatibility, sampleMetadata } from './fixtures.js';

/**
 * Regression tests for the package-installation path-traversal fix: a
 * package's name, version, and component paths must never be able to write
 * outside `<name>/<version>/` — including into another installed
 * package's directory, which the store's own root-escape check cannot
 * catch because it is still inside the store root.
 *
 * Every test runs against a disposable temp directory laid out as
 * `<sandbox>/store` (the BlobStore root) plus whatever sibling the test
 * wants to prove is untouched.
 */

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A bundle whose `knowledge_graph` component carries `evilPath` (the builder does not restrict paths — an attacker hand-crafts them anyway). */
function bundleWithComponentPath(evilPath: string, identity: { name?: string; version?: string } = {}): PackageBundle {
  const result = ManifestBuilder.create()
    .setIdentity({
      formatVersion: '1.0',
      name: identity.name ?? 'attacker_pkg',
      version: identity.version ?? '1.0.0',
      creatorDid: 'did:xo:attacker',
    })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'knowledge_graph', path: evilPath, data: enc('PWNED'), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: enc('{"rules":[]}'), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: enc('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`fixture failed to build: ${result.error.message}`);
  return result.value;
}

/** Like {@link bundleWithComponentPath} but carrying one extra component of `kind` at `extraPath` alongside the normal `knowledge/graph.json`. */
function bundleWithExtra(
  kind: 'lora' | 'finetune' | 'case_library',
  extraPath: string,
  graphPath = 'knowledge/graph.json',
  identity: { name?: string } = {},
): PackageBundle {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: identity.name ?? 'extra_pkg', version: '1.0.0', creatorDid: 'did:xo:attacker' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'knowledge_graph', path: graphPath, data: enc('GRAPH'), required: false })
    .addComponent({ kind, path: extraPath, data: enc('EXTRA'), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: enc('{"rules":[]}'), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: enc('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`fixture failed to build: ${result.error.message}`);
  return result.value;
}

/** Every file under `dir` (relative, sorted) with its content, so "no unintended writes" is an exact before/after equality check. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length)] = await readFile(full, 'utf8');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

interface Sandbox {
  readonly root: string;
  readonly sandbox: string;
  readonly installer: PackageInstaller;
  readonly victimRulesPath: string;
}

/** Sandbox with a pre-installed, legitimate "victim" package whose files an attacker would want to overwrite. */
async function withSandbox<T>(fn: (s: Sandbox) => Promise<T>): Promise<T> {
  const sandbox = await mkdtemp(join(tmpdir(), 'xo-path-confinement-'));
  try {
    const root = join(sandbox, 'store');
    await mkdir(root);
    const installer = new PackageInstaller(new LocalFsBlobStore(root));
    const victim = await installer.install(buildSampleBundle({ name: 'victim_pkg', version: '1.0.0' }));
    assert.equal(victim.ok, true, 'victim package must install cleanly as test setup');
    return await fn({ root, sandbox, installer, victimRulesPath: join(root, 'victim_pkg/1.0.0/safety/rules.json') });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/** Asserts `install()` refuses `bundle` AND leaves the entire sandbox byte-for-byte unchanged. */
async function assertRejectedWithNoWrites(
  s: Sandbox,
  bundle: PackageBundle,
  options?: { skipValidation?: boolean; force?: boolean },
): Promise<void> {
  const before = await snapshot(s.sandbox);
  const result = await s.installer.install(bundle, options);
  assert.equal(result.ok, false, 'unsafe package must be rejected');
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  assert.deepEqual(await snapshot(s.sandbox), before, 'a rejected package must cause zero writes anywhere in the sandbox');
}

// ── Legitimate packages keep working ────────────────────────────────────

test('legitimate package installs, with every component at <name>/<version>/<path>', async () => {
  await withSandbox(async (s) => {
    const bundle = buildSampleBundle({ name: 'good_pkg', version: '2.3.4' });
    const result = await s.installer.install(bundle);
    assert.equal(result.ok, true);
    const files = Object.keys(await snapshot(join(s.root, 'good_pkg')));
    for (const expected of [
      '/2.3.4/manifest.json',
      '/2.3.4/metadata.json',
      '/2.3.4/knowledge/graph.json',
      '/2.3.4/safety/rules.json',
      '/2.3.4/evaluation/benchmark_suite.json',
    ]) {
      assert.ok(files.includes(expected), `expected ${expected} to be installed`);
    }
    assert.equal((await s.installer.verifyInstallation('good_pkg', '2.3.4')).ok, true);
  });
});

test('existing and reasonable component path shapes remain accepted', async () => {
  await withSandbox(async (s) => {
    for (const [i, path] of [
      'knowledge/graph.json',
      'reasoning/reasoning_traces.jsonl',
      'knowledge/compiled-xoir.json',
      'a/b/c/deep.json',
      'knowledge/graph.v2.json',
      'flat.json',
      'dir/..hidden-ish.json',
    ].entries()) {
      const result = await s.installer.install(bundleWithComponentPath(path, { name: `compat_${i}` }));
      assert.equal(result.ok, true, `"${path}" should still be accepted`);
    }
  });
});

// ── Spec-supported shapes: directory-style `weights/lora/` entries ───────

test('spec-style directory paths (weights/lora/, weights/finetune/) still pack, unpack, install and read back as single-blob components', async () => {
  await withSandbox(async (s) => {
    for (const [kind, path] of [
      ['lora', 'weights/lora/'],
      ['finetune', 'weights/finetune/'],
    ] as const) {
      const name = `weights_${kind}`;
      const unpacked = await unpackArchive(await packBundle(bundleWithExtra(kind, path, 'knowledge/graph.json', { name })));
      assert.equal(unpacked.ok, true, `${path} must survive pack/unpack`);
      if (!unpacked.ok) return;
      assert.equal((await s.installer.install(unpacked.value)).ok, true, `${path} must install`);
      const read = await s.installer.getComponent(name, '1.0.0', kind);
      assert.equal(read.ok && new TextDecoder().decode(read.value), 'EXTRA');
      assert.equal((await s.installer.verifyInstallation(name, '1.0.0')).ok, true);
    }
  });
});

test('a directory-style path stays confined: its blob lands inside <name>/<version>/ and nowhere else', async () => {
  await withSandbox(async (s) => {
    const before = Object.keys(await snapshot(s.sandbox));
    assert.equal((await s.installer.install(bundleWithExtra('lora', 'weights/lora/'))).ok, true);
    const added = Object.keys(await snapshot(s.sandbox)).filter((f) => !before.includes(f));
    assert.ok(added.length > 0);
    for (const f of added)
      assert.ok(
        f.startsWith('/store/extra_pkg/1.0.0/') || f.startsWith('/store/_'),
        `unexpected write outside the package directory: ${f}`,
      );
  });
});

test('component collisions are rejected with zero writes (same file via trailing slash, file-vs-directory, case-insensitive duplicate)', async () => {
  await withSandbox(async (s) => {
    await assertRejectedWithNoWrites(s, bundleWithExtra('lora', 'weights/lora/', 'weights/lora'));
    await assertRejectedWithNoWrites(s, bundleWithExtra('lora', 'weights/lora/', 'weights/lora/adapter.bin'));
    await assertRejectedWithNoWrites(s, bundleWithExtra('lora', 'weights/lora/adapter.bin', 'weights/lora'));
    await assertRejectedWithNoWrites(s, bundleWithExtra('case_library', 'Knowledge/Graph.json'));
    await assertRejectedWithNoWrites(s, bundleWithExtra('lora', 'weights/lora/', 'weights/lora'), { skipValidation: true });
  });
});

test('PackageValidator reports COMPONENT_PATH_COLLISION', () => {
  const report = new PackageValidator().validateAll(bundleWithExtra('lora', 'weights/lora/', 'weights/lora'));
  assert.ok(report.issues.some((i) => i.severity === 'error' && i.code === 'COMPONENT_PATH_COLLISION'));
});

// ── Traversal / platform-specific paths are rejected with no writes ─────

const UNSAFE_COMPONENT_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['simple ../ traversal', '../../../escaped.txt'],
  ['leading ../', '../escaped.txt'],
  ['nested traversal that re-enters then escapes', 'a/b/../../../../escaped.txt'],
  ['traversal that stays inside the store (cross-package)', '../../victim_pkg/1.0.0/safety/rules.json'],
  ['absolute POSIX path', '/etc/xo-escaped.txt'],
  ['backslash traversal (Windows separators)', '..\\..\\..\\escaped.txt'],
  ['mixed separators', 'a/..\\..\\escaped.txt'],
  ['Windows drive prefix', 'C:\\escaped.txt'],
  ['Windows drive prefix, forward slash', 'C:/escaped.txt'],
  ['UNC path', '\\\\server\\share\\escaped.txt'],
  ['alternate data stream', 'knowledge/graph.json:evil'],
  ['"." segment', 'knowledge/./graph.json'],
  ['doubled slash (empty segment)', 'knowledge//graph.json'],
  ['double trailing slash', 'knowledge//'],
  ['bare traversal with trailing slash', '../'],
  ['bare dot with trailing slash', './'],
  ['only a slash', '/'],
  ['reserved manifest.json hidden behind a trailing slash', 'manifest.json/'],
  ['reserved metadata.json hidden behind a trailing slash', 'METADATA.json/'],
  ['NUL byte', 'knowledge/graph.json\u0000.txt'],
  ['control character', 'knowledge/gra\nph.json'],
  ['empty path', ''],
  ['installer-reserved manifest.json', 'manifest.json'],
  ['installer-reserved metadata.json (case-insensitive)', 'Metadata.JSON'],
];

for (const [label, evilPath] of UNSAFE_COMPONENT_PATHS) {
  test(`rejects unsafe component path — ${label}`, async () => {
    await withSandbox(async (s) => {
      await assertRejectedWithNoWrites(s, bundleWithComponentPath(evilPath));
    });
  });
}

test("malicious package cannot overwrite another package's files via a component path", async () => {
  await withSandbox(async (s) => {
    const victimBefore = await readFile(s.victimRulesPath, 'utf8');
    await assertRejectedWithNoWrites(s, bundleWithComponentPath('../../victim_pkg/1.0.0/safety/rules.json'));
    assert.equal(await readFile(s.victimRulesPath, 'utf8'), victimBefore);
  });
});

test('component path "manifest.json" cannot replace the package\'s own installed manifest', async () => {
  await withSandbox(async (s) => {
    await assertRejectedWithNoWrites(s, bundleWithComponentPath('manifest.json'));
  });
});

// ── Package name / version are part of the install location too ─────────

const UNSAFE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['leading ../', '../victim_pkg'],
  ['inner traversal that lands on another package', 'x/../victim_pkg'],
  ['slash (nested or other package directory)', 'victim_pkg/1.0.0'],
  ['".."', '..'],
  ['backslash', '..\\victim_pkg'],
  ['drive prefix', 'C:'],
  ['NUL byte', 'pkg\u0000'],
];

for (const [label, name] of UNSAFE_NAMES) {
  test(`rejects unsafe package name — ${label}`, async () => {
    await withSandbox(async (s) => {
      await assertRejectedWithNoWrites(s, bundleWithComponentPath('knowledge/graph.json', { name }));
    });
  });
}

test('malicious package cannot overwrite another package via its name', async () => {
  await withSandbox(async (s) => {
    const victimBefore = await readFile(s.victimRulesPath, 'utf8');
    const attack = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'x/../victim_pkg', version: '1.0.0', creatorDid: 'did:xo:attacker' })
      .setCompatibility(sampleCompatibility)
      .setMetadata(sampleMetadata)
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: enc('PWNED'), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: enc('PWNED'), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: enc('{}'), required: true })
      .build();
    assert.equal(attack.ok, true);
    if (!attack.ok) return;
    await assertRejectedWithNoWrites(s, attack.value);
    assert.equal(await readFile(s.victimRulesPath, 'utf8'), victimBefore);
  });
});

test('an unsafe version cannot overwrite another package, even when validation is skipped', async () => {
  await withSandbox(async (s) => {
    const victimBefore = await readFile(s.victimRulesPath, 'utf8');
    const good = buildSampleBundle({ name: 'attacker_pkg' });
    // "attacker_pkg/../victim_pkg/1.0.0" stays inside the store root and resolves to the victim's directory (the store's own root check cannot catch it).
    const evil: PackageBundle = { ...good, manifest: { ...good.manifest, version: '../victim_pkg/1.0.0' } };
    await assertRejectedWithNoWrites(s, evil, { skipValidation: true });
    assert.equal(await readFile(s.victimRulesPath, 'utf8'), victimBefore);
  });
});

test('legitimate package names are all still accepted (identifier-style, spec display-style, short, dotted, hyphenated)', async () => {
  await withSandbox(async (s) => {
    for (const name of [
      'xo_corp_contract_lawyer',
      'Corporate Contract & Commercial Lawyer',
      'x',
      'preview',
      'pkg.with.dots',
      'pkg-with-hyphens_and_underscores',
      'caf\u00e9_pkg',
    ]) {
      const result = await s.installer.install(bundleWithComponentPath('knowledge/graph.json', { name }));
      assert.equal(result.ok, true, `name "${name}" should still be accepted`);
      assert.equal((await s.installer.verifyInstallation(name, '1.0.0')).ok, true);
    }
  });
});

// ── Confinement is enforced even when other defenses are bypassed ───────

test('skipValidation does not bypass path confinement', async () => {
  await withSandbox(async (s) => {
    await assertRejectedWithNoWrites(s, bundleWithComponentPath('../../victim_pkg/1.0.0/safety/rules.json'), { skipValidation: true });
  });
});

test("checks the bundle's own component paths, not only the manifest's declared ones", async () => {
  await withSandbox(async (s) => {
    const good = buildSampleBundle({ name: 'attacker_pkg' });
    // Manifest still declares the safe path (and hashes depend only on bytes), but the component actually written carries a traversal path.
    const evil: PackageBundle = {
      ...good,
      components: good.components.map((c) =>
        c.kind === 'knowledge_graph' ? { ...c, path: '../../victim_pkg/1.0.0/safety/rules.json' } : c,
      ),
    };
    await assertRejectedWithNoWrites(s, evil);
    await assertRejectedWithNoWrites(s, evil, { skipValidation: true });
  });
});

test('force-reinstall and upgrade() cannot be used to smuggle an unsafe package past the gate', async () => {
  await withSandbox(async (s) => {
    const installed = await s.installer.install(buildSampleBundle({ name: 'attacker_pkg', version: '1.0.0' }));
    assert.equal(installed.ok, true);
    await assertRejectedWithNoWrites(
      s,
      bundleWithComponentPath('../../victim_pkg/1.0.0/safety/rules.json', { name: 'attacker_pkg', version: '1.0.0' }),
      { force: true },
    );

    const before = await snapshot(s.sandbox);
    const upgrade = await s.installer.upgrade(
      bundleWithComponentPath('../../victim_pkg/1.0.0/safety/rules.json', { name: 'attacker_pkg', version: '1.1.0' }),
    );
    assert.equal(upgrade.ok, false);
    assert.deepEqual(await snapshot(s.sandbox), before);

    const repair = await s.installer.repairInstallation(
      bundleWithComponentPath('../../victim_pkg/1.0.0/safety/rules.json', { name: 'attacker_pkg', version: '1.0.0' }),
    );
    assert.equal(repair.ok, false);
    assert.deepEqual(await snapshot(s.sandbox), before);
  });
});

// ── Earlier layers report the problem too (validator + schema) ──────────

test('PackageValidator.validateAll reports COMPONENT_PATH_UNSAFE and PACKAGE_IDENTITY_UNSAFE', () => {
  const validator = new PackageValidator();
  const pathReport = validator.validateAll(bundleWithComponentPath('../../x.txt'));
  assert.equal(pathReport.valid, false);
  assert.ok(pathReport.issues.some((i) => i.severity === 'error' && i.code === 'COMPONENT_PATH_UNSAFE'));

  const good = buildSampleBundle();
  const identityReport = validator.validateAll({ ...good, manifest: { ...good.manifest, name: '../victim_pkg' } });
  assert.equal(identityReport.valid, false);
  assert.ok(identityReport.issues.some((i) => i.severity === 'error' && i.code === 'PACKAGE_IDENTITY_UNSAFE'));

  assert.equal(validator.validateAll(good).valid, true, 'a legitimate bundle must still validate cleanly');
});

test('isXoManifest rejects unsafe component paths and names (so unpackArchive/getManifest refuse them)', () => {
  const good = buildSampleBundle().manifest;
  assert.equal(isXoManifest(good), true);
  const kg = good.components.knowledge_graph;
  assert.ok(kg);
  assert.equal(isXoManifest({ ...good, components: { ...good.components, knowledge_graph: { ...kg, path: '../../x' } } }), false);
  assert.equal(isXoManifest({ ...good, name: '../victim_pkg' }), false);
});

// ── Other entry points: caller-supplied name/version and install records ─

test('uninstall/getManifest/getComponent/verifyInstallation/rollback refuse unsafe names and cannot alias another package', async () => {
  await withSandbox(async (s) => {
    const before = await snapshot(s.sandbox);
    for (const alias of ['x/../victim_pkg', '../store/victim_pkg', 'victim_pkg/1.0.0', '..']) {
      for (const result of [
        await s.installer.uninstall(alias, '1.0.0'),
        await s.installer.getManifest(alias, '1.0.0'),
        await s.installer.getComponent(alias, '1.0.0', 'safety_rules'),
        await s.installer.verifyInstallation(alias, '1.0.0'),
        await s.installer.rollback(alias, '1.0.0'),
      ]) {
        assert.equal(result.ok, false, `"${alias}" must not resolve`);
        if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_NOT_INSTALLED');
      }
    }
    assert.equal(
      (await s.installer.getManifest('victim_pkg', '1.0.0')).ok,
      true,
      'the real victim package is untouched and still readable',
    );
    assert.deepEqual(await snapshot(s.sandbox), before);
  });
});

test('uninstall refuses a legacy install record that lists files outside its own package directory, deleting nothing', async () => {
  await withSandbox(async (s) => {
    // Simulate a record written by a PRE-FIX install of a malicious package: a legitimate install, then its stored record is edited to also list a victim file.
    assert.equal((await s.installer.install(buildSampleBundle({ name: 'attacker_pkg', version: '1.0.0' }))).ok, true);
    const recordPath = join(s.root, '_records', 'attacker_pkg@1.0.0.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { componentPaths: string[] };
    record.componentPaths.push('attacker_pkg/1.0.0/../../victim_pkg/1.0.0/safety/rules.json');
    await writeFile(recordPath, JSON.stringify(record));

    const before = await snapshot(s.sandbox);
    const result = await s.installer.uninstall('attacker_pkg', '1.0.0');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
      assert.match(result.error.message, /Nothing was deleted/);
    }
    assert.deepEqual(await snapshot(s.sandbox), before, "no file may be deleted, including the victim's");
  });
});

test('uninstall of a normal package still removes exactly its own files', async () => {
  await withSandbox(async (s) => {
    assert.equal((await s.installer.install(buildSampleBundle({ name: 'plain_pkg', version: '1.0.0' }))).ok, true);
    assert.equal((await s.installer.uninstall('plain_pkg', '1.0.0')).ok, true);
    assert.equal(Object.keys(await snapshot(join(s.root, 'plain_pkg'))).length, 0);
    assert.equal((await s.installer.getManifest('victim_pkg', '1.0.0')).ok, true, 'other packages are unaffected');
  });
});
