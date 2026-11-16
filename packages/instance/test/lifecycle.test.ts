import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  acquireInstanceLock,
  applySettingsToEnv,
  createBackup,
  createInstance,
  EncryptedFileSecretStore,
  END_OF_ARCHIVE,
  entryHeader,
  eraseInstance,
  LockHeldError,
  loadOrCreateSecretsKey,
  loadSettings,
  migrateInstance,
  openInstance,
  padding,
  readInstance,
  restoreBackup,
  SettingsInvalidError,
  verifyBackup,
  type Migration,
} from '../src/index.js';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-instance-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const V = '0.1.0-test';

test('an instance is created with its layout, refuses foreign folders, and is migrated forward step by step; newer data is refused', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    const meta = await createInstance(data, { xoVersion: V });
    assert.match(meta.instanceId, /^xoi_[0-9a-f]{32}$/);
    assert.equal(meta.schemaVersion, 1);
    assert.ok((await readdir(data)).includes('workspace-data'));
    await assert.rejects(createInstance(data, { xoVersion: V }), /already an XO instance/);

    const foreign = join(root, 'home');
    await mkdir(foreign);
    await writeFile(join(foreign, 'thesis.docx'), 'mine');
    await assert.rejects(createInstance(foreign, { xoVersion: V }), /already holds files XO did not put there \(thesis\.docx\)/);

    const ran: number[] = [];
    const more: Migration[] = [
      { version: 1, description: 'layout', up: async () => void ran.push(1) },
      { version: 2, description: 'split sources', up: async (d) => void (await writeFile(join(d, 'marker'), 'v2'), ran.push(2)) },
      { version: 3, description: 'index runs', up: async () => void ran.push(3) },
    ];
    const out = await migrateInstance(data, { xoVersion: '0.2.0', migrations: more });
    assert.deepEqual([out.from, out.to, ran], [1, 3, [2, 3]]);
    const after = await readInstance(data);
    assert.deepEqual(
      after!.history.map((h) => [h.from, h.to, h.with]),
      [
        [0, 1, V],
        [1, 2, '0.2.0'],
        [2, 3, '0.2.0'],
      ],
    );
    await assert.rejects(migrateInstance(data, { xoVersion: V }), /schema 3, written by a newer XO than this one \(which knows up to 1\)/);
  });
});

test('one runner per instance: a second holder is refused with who holds it; a lock left by a dead process on this host is taken over', async () => {
  await withDir(async (dir) => {
    const first = await acquireInstanceLock(dir, { purpose: 'instance' });
    const err = await acquireInstanceLock(dir, { purpose: 'backup' }).catch((e: unknown) => e);
    assert.ok(err instanceof LockHeldError);
    assert.match(err.message, new RegExp(`instance, process ${process.pid}`));
    await first.release();
    const stale = await acquireInstanceLock(dir, { purpose: 'instance', pid: 999_999 });
    void stale;
    const taken = await acquireInstanceLock(dir, { purpose: 'instance', isAlive: (pid) => pid !== 999_999 });
    assert.equal(taken.holder.pid, process.pid);
    const otherHost = await acquireInstanceLock(dir, { purpose: 'x', hostname: 'other' }).catch((e: unknown) => e);
    assert.ok(otherHost instanceof LockHeldError, 'a live holder is never taken over');
    await taken.release();
  });
});

test('secrets: encrypted at rest with a key kept elsewhere; only secret settings; tampering and wrong keys are detected', async () => {
  await withDir(async (dir) => {
    const keyFile = join(dir, 'keys', 'instance.key');
    const key = await loadOrCreateSecretsKey(keyFile, { create: true });
    if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    const store = new EncryptedFileSecretStore(join(dir, 'data', 'secrets.enc'), key);
    await store.set('ANTHROPIC_API_KEY', 'sk-ant-123');
    await store.set('XO_METRICS_TOKEN', 'scrape-me');
    await assert.rejects(store.set('PORT', '1'), /not a secret setting/);
    await assert.rejects(store.set('GEMINI_API_KEY', 'two\nlines'), /one non-empty line/);
    assert.deepEqual(await store.names(), ['ANTHROPIC_API_KEY', 'XO_METRICS_TOKEN']);
    const raw = await readFile(join(dir, 'data', 'secrets.enc'), 'utf8');
    assert.doesNotMatch(raw, /sk-ant-123/, 'nothing readable at rest');
    assert.equal(await store.remove('XO_METRICS_TOKEN'), true);
    const other = new EncryptedFileSecretStore(join(dir, 'data', 'secrets.enc'), Buffer.alloc(32, 7));
    await assert.rejects(other.load(), /cannot be decrypted with this key/);
    const parsed = JSON.parse(raw) as { data: string };
    await writeFile(
      join(dir, 'data', 'secrets.enc'),
      JSON.stringify({ ...JSON.parse(raw), data: Buffer.from('x' + parsed.data).toString('base64') }),
    );
    await assert.rejects(store.load(), /wrong key, or the file was altered/);
    if (process.platform !== 'win32') {
      await chmod(keyFile, 0o644);
      await assert.rejects(loadOrCreateSecretsKey(keyFile, { create: false }), /readable by other users/);
    }
  });
});

test('start-up: settings come from env, the data dir xo.env and the secrets file; problems stop it; the instance is created, locked and migrated', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    const keyFile = join(root, 'keys', 'k');
    await mkdir(data);
    await writeFile(join(data, 'xo.env'), 'PORT=4100\nXO_OCR=off\n');
    const key = await loadOrCreateSecretsKey(keyFile, { create: true });
    await new EncryptedFileSecretStore(join(data, 'secrets.enc'), key).set('ANTHROPIC_API_KEY', 'sk-from-file');
    const env = { XO_DATA_DIR: data, XO_SECRETS_KEY_FILE: keyFile, PORT: '4200', XO_TRUST_MODE: 'development' };
    const opened = await openInstance(env, { xoVersion: V });
    try {
      assert.equal(opened.created, true);
      assert.equal(opened.settings.env['PORT'], '4200');
      assert.equal(opened.settings.env['XO_OCR'], 'off');
      assert.equal(opened.settings.env['ANTHROPIC_API_KEY'], 'sk-from-file');
      assert.equal(opened.settings.env['API_KEYS_DIR'], join(data, 'api-keys'));
      await assert.rejects(openInstance(env, { xoVersion: V }), /this instance is in use \(instance/);
      const target: Record<string, string | undefined> = { PORT: '1' };
      applySettingsToEnv(opened.settings, target);
      assert.equal(target['PORT'], '1', 'the process environment is never overwritten');
      assert.equal(target['WORKSPACE_DATA_DIR'], join(data, 'workspace-data'));
    } finally {
      await opened.lock?.release();
    }
    const again = await openInstance(env, { xoVersion: V });
    assert.equal(again.created, false);
    assert.deepEqual(again.migration?.applied, []);
    await again.lock?.release();
    await assert.rejects(openInstance({ ...env, PORT: 'x', XO_OCR: 'maybe' }, { xoVersion: V }), (e: unknown) => {
      assert.ok(e instanceof SettingsInvalidError);
      assert.deepEqual(e.problems.map((p) => p.name).sort(), ['PORT', 'XO_OCR']);
      return true;
    });
    const noKey = await loadSettings({ XO_DATA_DIR: data, XO_TRUST_MODE: 'development' });
    assert.ok(noKey.errors.some((e) => e.name === 'XO_SECRETS_FILE' && /set XO_SECRETS_KEY_FILE/.test(e.message)));
  });
});

test('backup → verify → restore reproduces the data byte for byte, including long paths; standard tar can read the archive', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    await createInstance(data, { xoVersion: V });
    const deep = join(data, 'workspace-data', 'ws_' + 'a'.repeat(32), 'sources', 'src_' + 'b'.repeat(32), 'nested', 'deeper');
    await mkdir(deep, { recursive: true });
    await writeFile(
      join(deep, 'content-with-a-rather-long-file-name-that-pushes-the-path-past-one-hundred-bytes.bin'),
      Buffer.alloc(70_000, 3),
    );
    await writeFile(join(data, 'workspaces', 'empty.json'), '');
    await writeFile(join(data, 'api-keys', 'k.json'), '{"hash":"x"}');
    const out = join(root, 'backups', 'one.tar.gz');
    const made = await createBackup({ dataDir: data, outFile: out, xoVersion: V });
    assert.equal(made.manifest.consistency, 'stopped');
    assert.equal(made.manifest.files.length, 4);
    assert.ok(made.manifest.files.some((f) => f.path.length > 150));
    await assert.rejects(createBackup({ dataDir: data, outFile: out, xoVersion: V }), /already exists/);
    const v = await verifyBackup(out);
    assert.deepEqual(v.problems, []);
    try {
      const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
      assert.match(listing, /pushes-the-path-past-one-hundred-bytes\.bin/);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    const restored = join(root, 'restored');
    const r = await restoreBackup({ file: out, dataDir: restored });
    assert.equal(r.files, 4);
    const a = await readFile(join(deep, 'content-with-a-rather-long-file-name-that-pushes-the-path-past-one-hundred-bytes.bin'));
    const b = await readFile(
      join(restored, deep.slice(data.length), 'content-with-a-rather-long-file-name-that-pushes-the-path-past-one-hundred-bytes.bin'),
    );
    assert.ok(a.equals(b));
    assert.equal((await readInstance(restored))!.instanceId, made.manifest.instanceId);
    await assert.rejects(restoreBackup({ file: out, dataDir: restored }), /is not empty; restore into an empty folder, or pass --force/);
    const forced = await restoreBackup({ file: out, dataDir: restored, force: true });
    assert.match(forced.replacedDirMovedTo!, /restored\.replaced-/, 'the replaced folder is moved aside, never deleted');
  });
});

test('a running instance cannot be backed up (unless --live) or restored over; the data dir must not hold links', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    await createInstance(data, { xoVersion: V });
    const lock = await acquireInstanceLock(data, { purpose: 'instance' });
    await assert.rejects(createBackup({ dataDir: data, outFile: join(root, 'b.tar.gz'), xoVersion: V }), /in use/);
    const live = await createBackup({ dataDir: data, outFile: join(root, 'live.tar.gz'), xoVersion: V, live: true });
    assert.equal(live.manifest.consistency, 'live');
    assert.ok(!live.manifest.files.some((f) => f.path.endsWith('instance.lock')), 'the lock is never backed up');
    await assert.rejects(restoreBackup({ file: live.file, dataDir: data, force: true }), /in use/);
    await lock.release();
    if (process.platform !== 'win32') {
      await symlink('/etc/passwd', join(data, 'workspaces', 'link'));
      await assert.rejects(createBackup({ dataDir: data, outFile: join(root, 'c.tar.gz'), xoVersion: V }), /symbolic link/);
    }
  });
});

async function craft(file: string, entries: { path: string; type?: 'file' | 'directory' | 'link'; body?: string }[]): Promise<void> {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    if (e.type === 'link') {
      const h = entryHeader({ path: e.path, type: 'file', size: 0, mode: 0o644, mtime: new Date(0) });
      h[156] = '2'.charCodeAt(0);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      parts.push(h);
      continue;
    }
    parts.push(
      entryHeader({ path: e.path, type: e.type ?? 'file', size: body.length, mode: 0o644, mtime: new Date(0) }),
      body,
      Buffer.alloc(padding(body.length)),
    );
  }
  parts.push(END_OF_ARCHIVE);
  await pipeline(Readable.from([Buffer.concat(parts)]), createGzip(), createWriteStream(file));
}

test('a crafted or damaged archive is refused before anything is written: escaping paths, links, altered files, truncation', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    await createInstance(data, { xoVersion: V });
    await writeFile(join(data, 'api-keys', 'k.json'), 'original');
    const good = await createBackup({ dataDir: data, outFile: join(root, 'good.tar.gz'), xoVersion: V });
    const header = JSON.stringify({ ...good.manifest, directories: undefined, files: undefined, totalBytes: undefined });

    await craft(join(root, 'escape.tar.gz'), [
      { path: 'xo-backup/BACKUP.json', body: header },
      { path: 'data/../../outside.txt', body: 'x' },
    ]);
    const esc = await verifyBackup(join(root, 'escape.tar.gz'));
    assert.ok(esc.problems.some((p) => /unsafe or unexpected path/.test(p)));
    await assert.rejects(
      restoreBackup({ file: join(root, 'escape.tar.gz'), dataDir: join(root, 'r1') }),
      /failed verification; nothing was written/,
    );
    assert.deepEqual(
      (await readdir(root)).filter((n) => n.startsWith('r1') || n === 'outside.txt'),
      [],
    );

    await craft(join(root, 'link.tar.gz'), [{ path: 'data/api-keys', type: 'link' }]);
    assert.match((await verifyBackup(join(root, 'link.tar.gz'))).problems.join(), /contains a link, which backups never hold/);

    const manifest = { ...good.manifest };
    await craft(join(root, 'altered.tar.gz'), [
      { path: 'xo-backup/BACKUP.json', body: header },
      { path: 'data', type: 'directory' },
      ...good.manifest.directories.filter((d) => d !== 'data').map((d) => ({ path: d, type: 'directory' as const })),
      { path: 'data/instance.json', body: await readFile(join(data, 'instance.json'), 'utf8') },
      { path: 'data/api-keys/k.json', body: 'tampered' },
      { path: 'xo-backup/MANIFEST.json', body: JSON.stringify(manifest) },
    ]);
    assert.match(
      (await verifyBackup(join(root, 'altered.tar.gz'))).problems.join(),
      /data\/api-keys\/k\.json does not match its recorded hash/,
    );

    const bytes = await readFile(good.file);
    await writeFile(join(root, 'cut.tar.gz'), bytes.subarray(0, Math.floor(bytes.length / 2)));
    const cut = await verifyBackup(join(root, 'cut.tar.gz'));
    assert.equal(cut.ok, false);
    await writeFile(join(root, 'not-a-backup.tar.gz'), 'hello');
    assert.equal((await verifyBackup(join(root, 'not-a-backup.tar.gz'))).ok, false);
  });
});

test('erasure removes the data, the secrets key and the anchors, confirms each is gone, and needs the instance id', async () => {
  await withDir(async (root) => {
    const data = join(root, 'data');
    const meta = await createInstance(data, { xoVersion: V });
    await writeFile(join(data, 'api-keys', 'k.json'), 'k');
    const keyFile = join(root, 'keys', 'k.key');
    await loadOrCreateSecretsKey(keyFile, { create: true });
    const anchors = join(root, 'anchors');
    await mkdir(anchors);
    await writeFile(join(anchors, 'ws.json'), 'head');
    await assert.rejects(
      eraseInstance({ dataDir: data, confirmInstanceId: 'xoi_wrong' }),
      /does not match this instance .* nothing was removed/,
    );
    assert.ok((await readdir(data)).length > 0);
    const lock = await acquireInstanceLock(data, { purpose: 'instance' });
    await assert.rejects(eraseInstance({ dataDir: data, confirmInstanceId: meta.instanceId }), /in use/);
    await lock.release();
    const receipt = await eraseInstance({
      dataDir: data,
      confirmInstanceId: meta.instanceId,
      alsoRemove: [
        { path: keyFile, role: 'secrets key' },
        { path: anchors, role: 'audit anchors' },
      ],
    });
    assert.equal(receipt.verified, true);
    assert.deepEqual(
      receipt.paths.map((p) => [p.role, p.existedBefore, p.absentAfter]),
      [
        ['data directory', true, true],
        ['secrets key', true, true],
        ['audit anchors', true, true],
      ],
    );
    assert.ok(receipt.paths[0]!.files >= 2);
    assert.deepEqual((await readdir(root)).sort(), ['keys']);
  });
});
