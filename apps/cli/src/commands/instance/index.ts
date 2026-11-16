import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireInstanceLock,
  createBackup,
  createInstance,
  describeSettings,
  directoryUsage,
  EncryptedFileSecretStore,
  eraseInstance,
  LATEST_SCHEMA_VERSION,
  loadOrCreateSecretsKey,
  loadSettings,
  lockIsStale,
  migrateInstance,
  parseSecretsKey,
  pendingMigrations,
  readInstance,
  readLockHolder,
  restoreBackup,
  verifyBackup,
  type InstanceMetadata,
} from '@xo/instance';
import type { CommandRegistry } from '../../command-registry.js';
import type { ParsedArgs } from '../../arg-parser.js';
import { xoHome } from '../../tui/settings.js';

/**
 * UW-17 — one XO instance on this machine: `xo up` starts it (API, schedule triggers, Studio, on one port), `xo instance ...` creates,
 * inspects, backs up, restores, upgrades and deletes it, `xo secrets ...` manages its encrypted secrets.
 *
 * Paths: the data directory is `--data`, else `XO_DATA_DIR`, else `~/.xo/instances/default`. What must NOT live in it (so a copy of the
 * data is not a copy of everything) lives under `~/.xo/` by instance id: the secrets key (`keys/<id>.key`), the owner's access key
 * (`keys/<id>.owner-key`) and the audit anchors (`anchors/<id>`). Each can be set explicitly instead (XO_SECRETS_KEY_FILE,
 * XO_AUDIT_ANCHOR_DIR).
 */
const SUBSYSTEM = 'instance';
const XO_VERSION = '0.1.0';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const str = (f: ParsedArgs['flags'], k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const flag = (f: ParsedArgs['flags'], k: string): boolean => f[k] === true || f[k] === 'true';

export function dataDirFrom(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(str(args.flags, 'data') ?? env['XO_DATA_DIR'] ?? join(xoHome(env), 'instances', 'default'));
}

export interface InstancePaths {
  readonly keyFile: string;
  readonly ownerKeyFile: string;
  readonly anchorDir: string;
}

export function instancePaths(instanceId: string, env: NodeJS.ProcessEnv = process.env): InstancePaths {
  const home = xoHome(env);
  return {
    keyFile: resolve(env['XO_SECRETS_KEY_FILE'] ?? join(home, 'keys', `${instanceId}.key`)),
    ownerKeyFile: join(home, 'keys', `${instanceId}.owner-key`),
    anchorDir: resolve(env['XO_AUDIT_ANCHOR_DIR'] ?? join(home, 'anchors', instanceId)),
  };
}

/**
 * What `xo up` adds on this machine when nothing says otherwise: package trust in development mode (unsigned local packages run) unless
 * a trust policy is configured or this is production. `status` and `config check` apply the same, so they report what `xo up` runs.
 */
export function withLocalDefaults(env: NodeJS.ProcessEnv): { readonly env: NodeJS.ProcessEnv; readonly devTrust: boolean } {
  const devTrust =
    env['XO_TRUST_MODE'] === undefined &&
    env['XO_PACKAGE_TRUST_POLICY'] === undefined &&
    env['XO_ENV'] !== 'production' &&
    env['NODE_ENV'] !== 'production';
  return { env: devTrust ? { ...env, XO_TRUST_MODE: 'development' } : env, devTrust };
}

/** The built Studio shipped beside this CLI in the repository (apps/studio/dist). */
export function defaultStudioDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'studio', 'dist');
}

async function ensureInstance(dataDir: string): Promise<{ meta: InstanceMetadata; created: boolean }> {
  const existing = await readInstance(dataDir);
  if (existing !== undefined) return { meta: existing, created: false };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireInstanceLock(dataDir, { purpose: 'create' });
  try {
    const again = await readInstance(dataDir);
    if (again !== undefined) return { meta: again, created: false };
    return { meta: await createInstance(dataDir, { xoVersion: XO_VERSION }), created: true };
  } finally {
    await lock.release();
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function secretsStore(dataDir: string, meta: InstanceMetadata, create: boolean): Promise<EncryptedFileSecretStore> {
  const key =
    process.env['XO_SECRETS_KEY'] !== undefined
      ? parseSecretsKey(process.env['XO_SECRETS_KEY'])
      : await loadOrCreateSecretsKey(instancePaths(meta.instanceId).keyFile, { create });
  return new EncryptedFileSecretStore(resolve(process.env['XO_SECRETS_FILE'] ?? join(dataDir, 'secrets.enc')), key);
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const human = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

async function up(args: ParsedArgs): Promise<number> {
  const dataDir = dataDirFrom(args);
  const { meta, created } = await ensureInstance(dataDir);
  const paths = instancePaths(meta.instanceId);
  const noStudio = flag(args.flags, 'no-studio');
  const studioDir = noStudio ? undefined : resolve(str(args.flags, 'studio-dir') ?? process.env['XO_STUDIO_DIR'] ?? defaultStudioDir());
  if (studioDir !== undefined && !existsSync(join(studioDir, 'index.html'))) {
    return fail(
      `Studio is not built at ${studioDir}. Build it with: npm run build -w @xo/studio (or run with --no-studio for the API only)`,
    );
  }
  const env = process.env;
  env['XO_DATA_DIR'] = dataDir;
  env['XO_SECRETS_KEY_FILE'] ??= paths.keyFile;
  env['XO_AUDIT_ANCHOR_DIR'] ??= paths.anchorDir;
  if (studioDir !== undefined) env['XO_STUDIO_DIR'] = studioDir;
  const port = str(args.flags, 'port');
  const host = str(args.flags, 'host');
  if (port !== undefined) env['PORT'] = port;
  if (host !== undefined) env['HOST'] = host;
  // Local default: unsigned packages compiled here are usable. Never in production, never when a trust policy is configured.
  const { devTrust } = withLocalDefaults(env);
  if (devTrust) env['XO_TRUST_MODE'] = 'development';
  await loadOrCreateSecretsKey(env['XO_SECRETS_KEY_FILE'], { create: true });
  await mkdir(env['XO_AUDIT_ANCHOR_DIR'], { recursive: true, mode: 0o700 });

  const api = await import('@xo/api');
  const instance = await api.startInstance({ env, xoVersion: XO_VERSION });
  let keyLine: string;
  if (!existsSync(paths.ownerKeyFile)) {
    const issued = await api.issueAccessKey(env['API_KEYS_DIR']!, { identityId: 'owner', kind: 'human', expiresInDays: 90 });
    await mkdir(dirname(paths.ownerKeyFile), { recursive: true, mode: 0o700 });
    await writeFile(paths.ownerKeyFile, `${issued.rawKey}\n`, { mode: 0o600, flag: 'wx' });
    keyLine = `${issued.rawKey}\n         (saved to ${paths.ownerKeyFile}; expires ${issued.expiresAt ?? 'never'})`;
  } else keyLine = `saved in ${paths.ownerKeyFile}`;
  const bar = '─'.repeat(64);
  out(
    [
      '',
      bar,
      `  XO is running${created ? ' (new instance)' : ''}: ${meta.instanceId}`,
      `  Open    ${instance.publicUrl}${instance.servesStudio ? '' : '   (API only)'}`,
      `  Sign in with the access key (Development sign-in):`,
      `         ${keyLine}`,
      `  Data    ${dataDir}`,
      ...(devTrust
        ? ['  Note    package trust is in development mode (unsigned local packages run); set XO_PACKAGE_TRUST_POLICY to enforce']
        : []),
      '  Stop    Ctrl+C          Back up: xo instance backup',
      bar,
      '',
    ].join('\n'),
  );
  await new Promise<void>((done) => {
    const stop = () => void instance.stop().then(done);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function status(args: ParsedArgs): Promise<number> {
  const dataDir = dataDirFrom(args);
  const meta = await readInstance(dataDir);
  if (meta === undefined) return fail(`${dataDir} is not an XO instance (create one with: xo instance create, or xo up)`);
  const holder = await readLockHolder(dataDir);
  const running = holder !== undefined && !(await lockIsStale(holder));
  const usage = await directoryUsage(dataDir);
  const pending = pendingMigrations(meta).map((m) => m.version);
  const settings = await loadSettings(
    withLocalDefaults({ ...process.env, XO_DATA_DIR: dataDir, XO_SECRETS_KEY_FILE: instancePaths(meta.instanceId).keyFile }).env,
  );
  const report = {
    instanceId: meta.instanceId,
    dataDir,
    createdAt: meta.createdAt,
    schemaVersion: meta.schemaVersion,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    pendingMigrations: pending,
    state: running ? `running (${holder!.purpose}, process ${holder!.pid} on ${holder!.hostname} since ${holder!.since})` : 'stopped',
    files: usage.files,
    bytes: usage.bytes,
    settingsProblems: settings.errors,
    settingsWarnings: settings.warnings,
  };
  if (flag(args.flags, 'json')) out(JSON.stringify(report, null, 2));
  else {
    out(`instance   ${meta.instanceId}`);
    out(`data       ${dataDir}  (${usage.files} files, ${human(usage.bytes)})`);
    out(`state      ${report.state}`);
    out(
      `schema     ${meta.schemaVersion} of ${LATEST_SCHEMA_VERSION}${pending.length > 0 ? `  (pending: ${pending.join(', ')}; run xo instance upgrade)` : ''}`,
    );
    out(
      `settings   ${settings.errors.length === 0 ? 'ok' : `${settings.errors.length} problem(s)`}${settings.warnings.length > 0 ? `, ${settings.warnings.length} warning(s)` : ''}`,
    );
    for (const p of settings.errors) out(`  ✘ ${p.name} ${p.message}`);
    for (const p of settings.warnings) out(`  ! ${p.name} ${p.message}`);
  }
  return settings.errors.length === 0 ? 0 : 1;
}

async function backup(args: ParsedArgs): Promise<number> {
  const dataDir = dataDirFrom(args);
  const meta = await readInstance(dataDir);
  if (meta === undefined) return fail(`${dataDir} is not an XO instance`);
  const outFile = resolve(str(args.flags, 'out') ?? join(xoHome(), 'backups', `${meta.instanceId}-${stamp()}.tar.gz`));
  const r = await createBackup({ dataDir, outFile, xoVersion: XO_VERSION, live: flag(args.flags, 'live') });
  out(`backed up ${meta.instanceId} (${r.manifest.files.length} files, ${human(r.manifest.totalBytes)}, ${r.manifest.consistency})`);
  out(`  ${r.file}`);
  out(`  sha256 ${r.archiveSha256}  (${human(r.archiveBytes)})`);
  out(`  The secrets key is not in the backup. To restore elsewhere you also need ${instancePaths(meta.instanceId).keyFile}`);
  return 0;
}

async function upgrade(args: ParsedArgs): Promise<number> {
  const dataDir = dataDirFrom(args);
  const meta = await readInstance(dataDir);
  if (meta === undefined) return fail(`${dataDir} is not an XO instance`);
  const pending = pendingMigrations(meta);
  if (pending.length === 0) {
    out(`${meta.instanceId} is up to date (schema ${meta.schemaVersion})`);
    return 0;
  }
  const outFile = resolve(
    join(
      str(args.flags, 'backup-dir') ?? join(xoHome(), 'backups'),
      `${meta.instanceId}-before-schema-${pending[pending.length - 1]!.version}-${stamp()}.tar.gz`,
    ),
  );
  const b = await createBackup({ dataDir, outFile, xoVersion: XO_VERSION });
  out(`backup before upgrading: ${b.file}`);
  const lock = await acquireInstanceLock(dataDir, { purpose: 'upgrade' });
  try {
    const m = await migrateInstance(dataDir, { xoVersion: XO_VERSION });
    for (const a of m.applied) out(`  applied ${a.version}: ${a.description}`);
    out(`upgraded ${meta.instanceId}: schema ${m.from} → ${m.to}. To undo: xo instance restore ${b.file} --data ${dataDir} --force`);
  } finally {
    await lock.release();
  }
  return 0;
}

async function erase(args: ParsedArgs): Promise<number> {
  const dataDir = dataDirFrom(args);
  const meta = await readInstance(dataDir);
  if (meta === undefined) return fail(`${dataDir} is not an XO instance; nothing was removed`);
  const confirm = str(args.flags, 'confirm');
  if (confirm === undefined) {
    return fail(
      `deleting an instance removes all of its data, keys and sessions. To confirm, run: xo instance delete --data ${dataDir} --confirm ${meta.instanceId}`,
    );
  }
  const p = instancePaths(meta.instanceId);
  const receipt = await eraseInstance({
    dataDir,
    confirmInstanceId: confirm,
    alsoRemove: [
      { path: p.keyFile, role: 'secrets key' },
      { path: p.ownerKeyFile, role: 'owner access key' },
      { path: p.anchorDir, role: 'audit anchors' },
    ],
  });
  const text = JSON.stringify(receipt, null, 2);
  const receiptFile = str(args.flags, 'receipt');
  if (receiptFile !== undefined) await writeFile(resolve(receiptFile), `${text}\n`, { mode: 0o600, flag: 'wx' });
  out(text);
  return receipt.verified ? 0 : 1;
}

async function secrets(args: ParsedArgs): Promise<number> {
  const [sub, name] = args.positionals;
  const dataDir = dataDirFrom(args);
  const meta = await readInstance(dataDir);
  if (meta === undefined) return fail(`${dataDir} is not an XO instance (create one with: xo instance create)`);
  const store = await secretsStore(dataDir, meta, sub === 'set');
  if (sub === 'list') {
    const names = await store.names();
    out(names.length === 0 ? 'no secrets stored' : names.join('\n'));
    return 0;
  }
  if (name === undefined) return fail(`usage: xo secrets ${sub ?? '<set|list|remove>'} <NAME>`);
  if (sub === 'set') {
    if (process.stdin.isTTY === true) process.stderr.write(`Value for ${name} (input is read from standard input; end with Ctrl+D): `);
    const value = await readStdinLine();
    await store.set(name, value);
    out(`stored ${name} (encrypted; restart the instance to use it)`);
    return 0;
  }
  if (sub === 'remove') {
    out((await store.remove(name)) ? `removed ${name}` : `${name} was not stored`);
    return 0;
  }
  return fail('usage: xo secrets <set|list|remove> [NAME]');
}

export async function configCheck(args: ParsedArgs): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dataFlag = str(args.flags, 'data');
  if (dataFlag !== undefined) env['XO_DATA_DIR'] = resolve(dataFlag);
  if (env['XO_DATA_DIR'] !== undefined && env['XO_SECRETS_KEY_FILE'] === undefined) {
    const meta = await readInstance(resolve(env['XO_DATA_DIR']));
    if (meta !== undefined) env['XO_SECRETS_KEY_FILE'] = instancePaths(meta.instanceId).keyFile;
  }
  const s = await loadSettings(withLocalDefaults(env).env);
  if (flag(args.flags, 'json')) {
    out(
      JSON.stringify(
        {
          errors: s.errors,
          warnings: s.warnings,
          configFile: s.configFile,
          settings: describeSettings(s).filter((d) => d.value !== undefined),
        },
        null,
        2,
      ),
    );
  } else {
    if (s.configFile !== undefined) out(`config file  ${s.configFile}`);
    if (s.dataDir !== undefined) out(`data dir     ${s.dataDir}`);
    for (const d of describeSettings(s)) if (d.value !== undefined) out(`  ${d.name.padEnd(36)} ${d.value}   [${d.source}]`);
    for (const p of s.errors) out(`✘ ${p.name} ${p.message}`);
    for (const p of s.warnings) out(`! ${p.name} ${p.message}`);
    out(s.errors.length === 0 ? 'settings are valid' : `${s.errors.length} problem(s): the instance would not start`);
  }
  return s.errors.length === 0 ? 0 : 1;
}

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'Run and look after one XO instance on this machine (UW-17)');
  registry.register({
    name: 'up',
    subsystem: SUBSYSTEM,
    usage:
      'xo up [--data <dir>] [--port 4000] [--host 127.0.0.1] [--studio-dir <dir> | --no-studio]\n' +
      '                        Start a complete local instance (API, schedule triggers, Studio) on one port. Creates it on first run.',
    run: (args) => up(args),
  });
  registry.register({
    name: 'instance',
    subsystem: SUBSYSTEM,
    usage:
      'xo instance create|status [--data <dir>] [--json]                    Create an instance, or show its state, schema and settings\n' +
      'xo instance backup [--data <dir>] [--out <file.tar.gz>] [--live]     A stopped instance by default; --live while it runs\n' +
      'xo instance verify-backup <file.tar.gz>\n' +
      'xo instance restore <file.tar.gz> [--data <dir>] [--force]           Verified before anything is written; --force moves the old folder aside\n' +
      'xo instance upgrade [--data <dir>] [--backup-dir <dir>]              Backs up, then migrates the data to this version\n' +
      'xo instance access-key [--data <dir>] [--identity owner] [--days 90] [--service]   Issue a sign-in key (shown once)\n' +
      'xo instance delete --data <dir> --confirm <instance-id> [--receipt <file>]   Removes data, keys and anchors, and verifies they are gone',
    run: async (args) => {
      const sub = args.positionals[0];
      try {
        switch (sub) {
          case 'create': {
            const dataDir = dataDirFrom(args);
            const { meta, created } = await ensureInstance(dataDir);
            if (!created) return fail(`${dataDir} is already an XO instance (${meta.instanceId})`);
            await loadOrCreateSecretsKey(instancePaths(meta.instanceId).keyFile, { create: true });
            out(`created ${meta.instanceId} in ${dataDir}\nstart it with: xo up --data ${dataDir}`);
            return 0;
          }
          case 'status':
            return await status(args);
          case 'backup':
            return await backup(args);
          case 'verify-backup': {
            const file = args.positionals[1];
            if (file === undefined) return fail('usage: xo instance verify-backup <file.tar.gz>');
            const v = await verifyBackup(resolve(file));
            if (v.ok)
              out(
                `ok: ${v.header!.instanceId}, schema ${v.header!.schemaVersion}, ${v.manifest!.files.length} files, taken ${v.header!.createdAt} (${v.header!.consistency})`,
              );
            else for (const p of v.problems) out(`✘ ${p}`);
            return v.ok ? 0 : 1;
          }
          case 'restore': {
            const file = args.positionals[1];
            if (file === undefined) return fail('usage: xo instance restore <file.tar.gz> [--data <dir>] [--force]');
            const dataDir = dataDirFrom(args);
            const r = await restoreBackup({ file: resolve(file), dataDir, force: flag(args.flags, 'force') });
            const m = await migrateInstance(dataDir, { xoVersion: XO_VERSION });
            out(`restored ${r.header.instanceId} into ${dataDir} (${r.files} files, ${human(r.bytes)})`);
            if (m.applied.length > 0) out(`  migrated schema ${m.from} → ${m.to}`);
            if (r.replacedDirMovedTo !== undefined) out(`  the folder that was there is now ${r.replacedDirMovedTo}`);
            const key = instancePaths(r.header.instanceId).keyFile;
            if (existsSync(join(dataDir, 'secrets.enc')) && !existsSync(key) && process.env['XO_SECRETS_KEY'] === undefined)
              out(`  ! the secrets file needs its key: put it at ${key} (or set XO_SECRETS_KEY_FILE)`);
            return 0;
          }
          case 'access-key': {
            // For an instance not started by `xo up` (a container, a server): issue a sign-in key for a person, printed once.
            const dataDir = dataDirFrom(args);
            const meta = await readInstance(dataDir);
            if (meta === undefined) return fail(`${dataDir} is not an XO instance`);
            const identity = str(args.flags, 'identity') ?? 'owner';
            const days = Number(str(args.flags, 'days') ?? '90');
            const api = await import('@xo/api');
            const issued = await api.issueAccessKey(resolve(process.env['API_KEYS_DIR'] ?? join(dataDir, 'api-keys')), {
              identityId: identity,
              kind: flag(args.flags, 'service') ? 'service' : 'human',
              expiresInDays: days,
            });
            out(`access key for "${identity}" (expires ${issued.expiresAt ?? 'never'}); it is shown once and only its hash is stored:`);
            out(issued.rawKey);
            return 0;
          }
          case 'upgrade':
            return await upgrade(args);
          case 'delete':
            return await erase(args);
          default:
            return fail(
              'usage: xo instance <create|status|backup|verify-backup|restore|upgrade|access-key|delete> ... (xo instance --help)',
            );
        }
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
  registry.register({
    name: 'secrets',
    subsystem: SUBSYSTEM,
    usage:
      'xo secrets set <NAME> [--data <dir>]       Store a secret setting, encrypted (the value is read from standard input, never from the command line)\n' +
      'xo secrets list|remove [NAME] [--data <dir>]   Names only; values are never printed',
    run: async (args) => {
      try {
        return await secrets(args);
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
}
