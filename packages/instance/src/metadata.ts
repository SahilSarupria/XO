import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * UW-17 (ADR 0023, rule 5) — what an instance is, and how its stored data moves between versions.
 *
 * `instance.json` in the data directory names the instance and the schema version its data is in. Migrations are ordered, each
 * moves the data one version forward and is recorded in the file's history. A data directory written by a newer XO is refused rather
 * than read by code that does not understand it.
 */
export const INSTANCE_FILE = 'instance.json';
export const LOCK_FILE = 'instance.lock';
export const DEFAULT_CONFIG_FILE = 'xo.env';

export interface InstanceMetadata {
  readonly format: 1;
  readonly instanceId: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly createdWith: string;
  readonly history: readonly { readonly from: number; readonly to: number; readonly at: string; readonly with: string }[];
}

export interface Migration {
  readonly version: number;
  readonly description: string;
  up(dataDir: string): Promise<void>;
}

/** The folders every instance has. Others (audit, password sign-in) appear when their feature is turned on. */
export const LAYOUT_DIRS: readonly string[] = [
  'api-keys',
  'workspaces',
  'workspace-data',
  'sessions',
  'accounts',
  'oidc-bindings',
  'external-effects',
  'inference-cache',
];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'instance layout: one folder per kind of state inside the data directory',
    async up(dataDir) {
      for (const d of LAYOUT_DIRS) await mkdir(join(dataDir, d), { recursive: true, mode: 0o700 });
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class InstanceError extends Error {}

export async function readInstance(dataDir: string): Promise<InstanceMetadata | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, INSTANCE_FILE), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
  let m: InstanceMetadata;
  try {
    m = JSON.parse(raw) as InstanceMetadata;
  } catch {
    throw new InstanceError(`${join(dataDir, INSTANCE_FILE)} is not valid JSON`);
  }
  if (m.format !== 1 || typeof m.instanceId !== 'string' || !Number.isInteger(m.schemaVersion)) {
    throw new InstanceError(`${join(dataDir, INSTANCE_FILE)} is not an XO instance file`);
  }
  return m;
}

async function writeInstance(dataDir: string, m: InstanceMetadata): Promise<void> {
  const path = join(dataDir, INSTANCE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Names that may already be in a directory adopted as an instance (an older layout, or settings written first). */
const ADOPTABLE = new Set([...LAYOUT_DIRS, 'audit', 'secrets.enc', DEFAULT_CONFIG_FILE, LOCK_FILE]);

/**
 * Makes `dataDir` an instance: writes `instance.json` and runs every migration. An existing directory is adopted only when everything
 * in it is something XO itself puts there, so pointing `XO_DATA_DIR` at the wrong folder cannot scatter XO data through it.
 */
export async function createInstance(
  dataDir: string,
  opts: { readonly xoVersion: string; readonly now?: () => Date; readonly migrations?: readonly Migration[] },
): Promise<InstanceMetadata> {
  if ((await readInstance(dataDir)) !== undefined) throw new InstanceError(`${dataDir} is already an XO instance`);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const foreign = (await readdir(dataDir)).filter((n) => !ADOPTABLE.has(n));
  if (foreign.length > 0) {
    throw new InstanceError(
      `${dataDir} already holds files XO did not put there (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', ...' : ''}); choose an empty folder`,
    );
  }
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const created: InstanceMetadata = {
    format: 1,
    instanceId: `xoi_${randomUUID().replace(/-/g, '')}`,
    schemaVersion: 0,
    createdAt: now,
    createdWith: opts.xoVersion,
    history: [],
  };
  await writeInstance(dataDir, created);
  await migrateInstance(dataDir, opts);
  return (await readInstance(dataDir))!;
}

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly { readonly version: number; readonly description: string }[];
}

export function pendingMigrations(meta: InstanceMetadata, migrations: readonly Migration[] = MIGRATIONS): readonly Migration[] {
  return migrations.filter((m) => m.version > meta.schemaVersion);
}

/** Brings the data up to the newest schema this code knows. Each step is recorded as soon as it completes, so a crash resumes there. */
export async function migrateInstance(
  dataDir: string,
  opts: { readonly xoVersion: string; readonly now?: () => Date; readonly migrations?: readonly Migration[] },
): Promise<MigrationOutcome> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  let meta = await readInstance(dataDir);
  if (meta === undefined) throw new InstanceError(`${dataDir} is not an XO instance (no ${INSTANCE_FILE}); create it first`);
  if (meta.schemaVersion > latest) {
    throw new InstanceError(
      `this data is at schema ${meta.schemaVersion}, written by a newer XO than this one (which knows up to ${latest}); run the newer XO, or restore a backup taken before the upgrade`,
    );
  }
  const from = meta.schemaVersion;
  const applied: { version: number; description: string }[] = [];
  for (const m of pendingMigrations(meta, migrations)) {
    await m.up(dataDir);
    const at = (opts.now ?? (() => new Date()))().toISOString();
    meta = {
      ...meta,
      schemaVersion: m.version,
      history: [...meta.history, { from: meta.schemaVersion, to: m.version, at, with: opts.xoVersion }],
    };
    await writeInstance(dataDir, meta);
    applied.push({ version: m.version, description: m.description });
  }
  return { from, to: meta.schemaVersion, applied };
}
