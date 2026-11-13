import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireInstanceLock, type InstanceLock, type LockOptions } from './lock.js';
import {
  createInstance,
  DEFAULT_CONFIG_FILE,
  migrateInstance,
  readInstance,
  type InstanceMetadata,
  type MigrationOutcome,
} from './metadata.js';
import { EncryptedFileSecretStore, loadOrCreateSecretsKey, parseSecretsKey, SecretsError } from './secrets.js';
import { resolveSettings, type Env, type ResolvedSettings, type SettingsProblem } from './settings.js';

/**
 * UW-17 — the start-up sequence every way of running an instance shares (`xo up`, the API entrypoint, the container): read settings
 * from the environment, the config file and the secrets file; refuse to start on any problem, listing all of them; take the instance
 * lock; create the instance on first start or bring its data up to date; and only then hand over.
 */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

export interface LoadedSettings extends ResolvedSettings {
  /** Where secrets came from, when a secrets file was read. */
  readonly secretsFile?: string;
}

/** Reads everything that decides the settings, without writing anything. */
export async function loadSettings(processEnv: Env, opts: { readonly cwd?: string } = {}): Promise<LoadedSettings> {
  const abs = (p: string) => resolve(opts.cwd ?? process.cwd(), p);
  const extra: SettingsProblem[] = [];
  const explicitConfig = processEnv['XO_CONFIG_FILE'];
  let configFile: { path: string; text: string } | undefined;
  if (explicitConfig !== undefined && explicitConfig.trim() !== '') {
    const text = await readOptional(abs(explicitConfig));
    if (text === undefined) extra.push({ name: 'XO_CONFIG_FILE', message: `${explicitConfig} does not exist` });
    else configFile = { path: abs(explicitConfig), text };
  }
  // The data directory may be named by the environment or by an explicit config file; its own xo.env is read when present.
  const probe = resolveSettings(processEnv, { ...(configFile !== undefined ? { configFile } : {}), joinPath: join });
  const dataDir = probe.env['XO_DATA_DIR'] !== undefined ? abs(probe.env['XO_DATA_DIR']) : undefined;
  if (configFile === undefined && dataDir !== undefined) {
    const path = join(dataDir, DEFAULT_CONFIG_FILE);
    const text = await readOptional(path);
    if (text !== undefined) configFile = { path, text };
  }
  const env = { ...processEnv, ...(dataDir !== undefined ? { XO_DATA_DIR: dataDir } : {}) };
  const first = resolveSettings(env, { ...(configFile !== undefined ? { configFile } : {}), joinPath: join });

  let secrets: Record<string, string> | undefined;
  let secretsFile: string | undefined;
  const file = first.env['XO_SECRETS_FILE'];
  if (file !== undefined) {
    const present = (await readOptional(abs(file))) !== undefined;
    if (present) {
      try {
        const keyText = first.env['XO_SECRETS_KEY'];
        const keyFile = first.env['XO_SECRETS_KEY_FILE'];
        if (keyText === undefined && keyFile === undefined)
          throw new SecretsError('set XO_SECRETS_KEY_FILE (or XO_SECRETS_KEY) to read it');
        const key = keyText !== undefined ? parseSecretsKey(keyText) : await loadOrCreateSecretsKey(abs(keyFile!), { create: false });
        secrets = { ...(await new EncryptedFileSecretStore(abs(file), key).load()) };
        secretsFile = abs(file);
      } catch (cause) {
        extra.push({ name: 'XO_SECRETS_FILE', message: `${file}: ${cause instanceof Error ? cause.message : String(cause)}` });
      }
    }
  }
  const resolved =
    secrets === undefined ? first : resolveSettings(env, { ...(configFile !== undefined ? { configFile } : {}), secrets, joinPath: join });
  return {
    ...resolved,
    errors: [...extra, ...resolved.errors],
    ...(secretsFile !== undefined ? { secretsFile } : {}),
  };
}

export class SettingsInvalidError extends Error {
  constructor(readonly problems: readonly SettingsProblem[]) {
    super(`the instance settings are not valid:\n${problems.map((p) => `  - ${p.name} ${p.message}`).join('\n')}`);
  }
}

export interface OpenedInstance {
  readonly settings: LoadedSettings;
  readonly dataDir?: string;
  readonly meta?: InstanceMetadata;
  readonly created: boolean;
  readonly migration?: MigrationOutcome;
  readonly lock?: InstanceLock;
}

/**
 * Validates settings (all problems at once) and, when `XO_DATA_DIR` is set, locks the instance, creates it on first start, and runs
 * pending migrations. Without `XO_DATA_DIR` the legacy layout of separate folders is used, with no lock, metadata or migrations.
 */
export async function openInstance(
  processEnv: Env,
  opts: { readonly xoVersion: string; readonly purpose?: string; readonly cwd?: string; readonly lock?: Omit<LockOptions, 'purpose'> },
): Promise<OpenedInstance> {
  const settings = await loadSettings(processEnv, opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  if (settings.errors.length > 0) throw new SettingsInvalidError(settings.errors);
  const dataDir = settings.dataDir;
  if (dataDir === undefined) return { settings, created: false };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireInstanceLock(dataDir, { ...opts.lock, purpose: opts.purpose ?? 'instance' });
  try {
    const existing = await readInstance(dataDir);
    if (existing === undefined) {
      const meta = await createInstance(dataDir, { xoVersion: opts.xoVersion });
      return { settings, dataDir, meta, created: true, lock };
    }
    const migration = await migrateInstance(dataDir, { xoVersion: opts.xoVersion });
    return { settings, dataDir, meta: (await readInstance(dataDir))!, created: false, migration, lock };
  } catch (cause) {
    await lock.release();
    throw cause;
  }
}

/** Puts the resolved values the process environment lacks into it, so every part of the instance reads the same settings. */
export function applySettingsToEnv(settings: ResolvedSettings, target: Record<string, string | undefined> = process.env): void {
  for (const [k, v] of Object.entries(settings.env)) if (target[k] === undefined || (target[k] === '' && v !== '')) target[k] = v;
}
