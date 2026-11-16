/**
 * UW-14c–e (ADR 0037) — a workspace's data protection, on the API side.
 *
 *   - the known-value dictionary (14c-1): built from the workspace's own spreadsheets (the columns that identify someone: names,
 *     emails, phones, ids) plus values and columns an administrator adds in the workspace's data-protection settings;
 *   - the protection context (14e): every /workspaces/{id}/… request runs inside one, so any model request that request makes is
 *     scanned with that workspace's dictionary before it can leave (`@xo/ai-core` guardProvider); a blocked request is audited with
 *     hashes only;
 *   - token vaults (14d): one per workflow, sealed under a key derived per workspace from XO_CREDENTIALS_KEY, kept for
 *     XO_TOKEN_VAULT_RETENTION_DAYS and erased when the workflow is archived.
 *
 * The dictionary is the customer's data and stays where the customer's data is: in memory on this instance, never logged, never in
 * an error, never in an audit event (hashes only).
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  KnownValueDictionary,
  PATTERN_ONLY_SCANNER,
  ProtectionScanner,
  TokenVault,
  sealVault,
  unsealVault,
  vaultKey,
  type KnownValueKind,
  type LeakVerdict,
  type ProtectionContext,
} from '@xo/ai-core';
import { actorFromPrincipal, SYSTEM_ACTOR } from '@xo/audit';
import { tabularFromCsv, tabularFromXlsx, type RecordSet } from '@xo/compiler';
import { ErrorCode, XoError } from '@xo/errors';
import type { AuditService } from '../audit/audit-service.js';
import { newCorrelationId } from '../audit/audit-service.js';
import type { CredentialsConfig } from '../credentials/credentials.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import type { ApiRequest } from '../http/types.js';
import { workspaceSourcesStore, workspaceStateStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';

export const KNOWN_VALUE_KINDS: readonly KnownValueKind[] = ['name', 'organization', 'email', 'phone', 'identifier', 'address', 'other'];
export const MAX_SETTING_VALUES = 5000;
export const MAX_SETTING_COLUMNS = 200;
/** A workspace's dictionary stops growing here (and says so): a bound on memory, not on protection of what is in it. */
export const MAX_KNOWN_VALUES = 250_000;
const SETTINGS_KEY = 'data-protection.json';

export interface DataProtectionSettings {
  readonly schema: 'xo.data-protection/1';
  readonly revision: number;
  /** Values to protect that are not in any spreadsheet (a client typed into a goal, a family name, a project code). */
  readonly values: readonly { readonly value: string; readonly kind: KnownValueKind }[];
  /** Column headers whose values are always protected, whatever they look like (matched case-insensitively). */
  readonly protectColumns: readonly string[];
  /** Column headers never treated as identifying (a "Product name" column). */
  readonly ignoreColumns: readonly string[];
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export const EMPTY_SETTINGS: DataProtectionSettings = {
  schema: 'xo.data-protection/1',
  revision: 0,
  values: [],
  protectColumns: [],
  ignoreColumns: [],
};

export async function readSettings(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<DataProtectionSettings> {
  const got = await workspaceStateStore(workspace, config).get(SETTINGS_KEY);
  if (!got.ok) return EMPTY_SETTINGS;
  const s = JSON.parse(new TextDecoder().decode(got.value)) as DataProtectionSettings;
  if (s.schema !== 'xo.data-protection/1') throw new XoError(ErrorCode.UNKNOWN, 'the data-protection settings file is not recognised');
  return s;
}

export async function writeSettings(workspace: WorkspaceRecord, config: WorkspaceDataConfig, next: DataProtectionSettings): Promise<void> {
  const put = await workspaceStateStore(workspace, config).put(SETTINGS_KEY, new TextEncoder().encode(JSON.stringify(next)));
  if (!put.ok) throw put.error;
}

/** Validates a settings change from a request body. */
export function parseSettings(body: Record<string, unknown>, current: DataProtectionSettings): Omit<DataProtectionSettings, 'schema'> {
  const bad = (m: string): never => {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, m);
  };
  const values = body['values'] ?? current.values;
  if (!Array.isArray(values) || values.length > MAX_SETTING_VALUES) bad(`"values" is a list of at most ${MAX_SETTING_VALUES}`);
  const parsedValues = (values as unknown[]).map((v, i) => {
    const o = v as { value?: unknown; kind?: unknown };
    if (typeof o !== 'object' || o === null || typeof o.value !== 'string' || o.value.trim() === '' || o.value.length > 200)
      bad(`values[${i}].value is a non-empty string of at most 200 characters`);
    if (!KNOWN_VALUE_KINDS.includes(o.kind as KnownValueKind)) bad(`values[${i}].kind is one of ${KNOWN_VALUE_KINDS.join(', ')}`);
    return { value: (o.value as string).trim(), kind: o.kind as KnownValueKind };
  });
  const columns = (key: 'protectColumns' | 'ignoreColumns'): string[] => {
    const v = body[key] ?? current[key];
    if (!Array.isArray(v) || v.length > MAX_SETTING_COLUMNS || v.some((x) => typeof x !== 'string' || x.trim() === '' || x.length > 120))
      bad(`"${key}" is a list of at most ${MAX_SETTING_COLUMNS} column headers`);
    return [...new Set((v as string[]).map((x) => x.trim()))];
  };
  return {
    revision: current.revision + 1,
    values: parsedValues,
    protectColumns: columns('protectColumns'),
    ignoreColumns: columns('ignoreColumns'),
  };
}

// ------------------------------------------------------------------------------------------------ which columns identify someone

const HEADER_KINDS: readonly (readonly [RegExp, KnownValueKind])[] = [
  [/e-?mail/, 'email'],
  [/\b(?:phone|mobile|cell|whatsapp|tel|telephone|contact (?:no|number))\b/, 'phone'],
  [/\b(?:address|street|locality|flat|house)\b/, 'address'],
  [
    /\b(?:pan|aadhaar|aadhar|uid|gstin|gst|ifsc|account|a\/c|acct|policy|folio|uan|pf|esic|passport|voter|epic|licen[cs]e|registration|reg|customer id|client id|member id|employee id|emp id|emp code|employee code|id)\b/,
    'identifier',
  ],
  [/\b(?:company|firm|organi[sz]ation|vendor|supplier|business|employer|party|insurer|bank|entity)\b/, 'organization'],
  [
    /\b(?:name|client|customer|insured|nominee|beneficiary|holder|contact|person|employee|member|proposer|guardian|father|mother|spouse)\b/,
    'name',
  ],
];
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONEISH = /^(?:\+?91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}$/;

/** The kind of identifying value a column holds, or undefined when it is not one (decided from the header, then the values). */
export function classifyColumn(
  header: string,
  sample: readonly string[],
  settings: Pick<DataProtectionSettings, 'protectColumns' | 'ignoreColumns'>,
): KnownValueKind | undefined {
  const h = header.trim().toLowerCase().replace(/[_.]+/g, ' ');
  if (settings.ignoreColumns.some((c) => c.toLowerCase() === h)) return undefined;
  const filled = sample.filter((v) => v.trim() !== '');
  const share = (re: RegExp) => (filled.length === 0 ? 0 : filled.filter((v) => re.test(v.trim())).length / filled.length);
  if (share(EMAILISH) >= 0.6) return 'email';
  if (share(PHONEISH) >= 0.6) return 'phone';
  for (const [re, kind] of HEADER_KINDS) if (re.test(h)) return kind;
  if (settings.protectColumns.some((c) => c.toLowerCase() === h)) return 'other';
  return undefined;
}

export interface ColumnReport {
  readonly sourceId: string;
  readonly recordSet: string;
  readonly header: string;
  readonly kind: KnownValueKind;
  readonly values: number;
}

function addRecordSet(
  d: KnownValueDictionary,
  rs: RecordSet,
  settings: DataProtectionSettings,
  sourceId: string,
  report: ColumnReport[],
): void {
  for (const col of rs.columns) {
    const values = rs.records
      .map((r) => r.cells[col.column])
      .filter((c) => c !== undefined && (c.kind === 'string' || c.kind === 'number'));
    const raw = values.map((c) => c!.raw);
    const kind = classifyColumn(col.header, raw.slice(0, 200), settings);
    if (kind === undefined) continue;
    let n = 0;
    for (const v of raw) {
      if (d.size >= MAX_KNOWN_VALUES) break;
      const before = d.size;
      d.add({ value: v, kind });
      if (d.size > before) n++;
    }
    report.push({ sourceId, recordSet: rs.id, header: col.header.slice(0, 120), kind, values: n });
  }
}

export interface BuiltDictionary {
  readonly scanner: ProtectionScanner;
  readonly columns: readonly ColumnReport[];
  readonly knownValues: number;
  readonly truncated: boolean;
  readonly unreadable: readonly string[];
}

/** Reads the workspace's spreadsheets and settings into a scanner. */
export async function buildDictionary(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<BuiltDictionary> {
  const settings = await readSettings(workspace, config);
  const d = new KnownValueDictionary();
  for (const v of settings.values) d.add(v);
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  const list = await sources.list();
  const columns: ColumnReport[] = [];
  const unreadable: string[] = [];
  if (list.ok)
    for (const s of list.value) {
      if (s.extension !== '.csv' && s.extension !== '.xlsx') continue;
      const bytes = await sources.getContent(s.sourceId);
      if (!bytes.ok) continue;
      const t = s.extension === '.csv' ? tabularFromCsv(new TextDecoder().decode(bytes.value)) : tabularFromXlsx(bytes.value);
      if (!t.ok) {
        unreadable.push(s.sourceId);
        continue;
      }
      for (const rs of t.value.recordSets) addRecordSet(d, rs, settings, s.sourceId, columns);
    }
  return {
    scanner: new ProtectionScanner({ dictionary: d }),
    columns,
    knownValues: d.size,
    truncated: d.size >= MAX_KNOWN_VALUES,
    unreadable,
  };
}

/** What the dictionary was built from: it is rebuilt when a spreadsheet or the settings change. */
async function dictionaryKey(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<string> {
  const settings = await readSettings(workspace, config);
  const list = await new FsSourceStore(workspaceSourcesStore(workspace, config)).list();
  const digests = list.ok
    ? list.value
        .filter((s) => s.extension === '.csv' || s.extension === '.xlsx')
        .map((s) => `${s.sourceId}:${s.digestSha256}`)
        .sort()
    : [];
  return `${settings.revision}|${digests.join(',')}`;
}

// ------------------------------------------------------------------------------------------------ the protection context

export class DataProtection {
  private readonly cache = new Map<string, { readonly key: string; readonly built: Promise<BuiltDictionary> }>();

  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly config: WorkspaceDataConfig,
    private readonly audit: AuditService,
  ) {}

  /** The workspace's dictionary, rebuilt only when what it is built from changed. */
  async dictionary(workspace: WorkspaceRecord): Promise<BuiltDictionary> {
    const key = await dictionaryKey(workspace, this.config);
    const have = this.cache.get(workspace.workspaceId);
    if (have !== undefined && have.key === key) return have.built;
    const built = buildDictionary(workspace, this.config);
    this.cache.set(workspace.workspaceId, { key, built });
    built.catch(() => this.cache.delete(workspace.workspaceId));
    return built;
  }

  /** The context a request runs in: the workspace in its path, if there is one and it exists. */
  contextFor(req: ApiRequest, workspaceId: string): ProtectionContext {
    return {
      scope: workspaceId,
      scanner: async () => {
        const ws = await this.workspaceStore.get(workspaceId);
        // An unknown workspace has no values to protect; the pattern packs still apply. (The route itself answers 404.)
        return ws.ok ? (await this.dictionary(ws.value)).scanner : PATTERN_ONLY_SCANNER;
      },
      onBlocked: (verdict, about) => this.recordBlocked(req, workspaceId, verdict, about.providerId),
    };
  }

  private async recordBlocked(req: ApiRequest, workspaceId: string, verdict: LeakVerdict, providerId: string): Promise<void> {
    const hashes = [...new Set(verdict.hits.map((h) => h.hash))];
    await this.audit.tryRecord({
      action: 'model.egress',
      actor: req.principal !== undefined ? actorFromPrincipal(req.principal) : SYSTEM_ACTOR,
      correlationId: newCorrelationId(),
      target: { kind: 'workspace', id: workspaceId, workspaceId },
      type: 'model.egress.blocked',
      outcome: 'denied',
      reasonCode: 'leak_guard_blocked',
      metadata: {
        provider: providerId.slice(0, 64),
        hits: verdict.hits.length,
        entities: [...new Set(verdict.hits.map((h) => h.entity))].join(',').slice(0, 128),
        detectors: [...new Set(verdict.hits.map((h) => h.detector))].join(',').slice(0, 128),
        // Hashes of the normalised value (sha256, 16 hex): enough to find which value it was, never the value.
        hashes: hashes.slice(0, 5).join(','),
        encoded: verdict.hits.some((h) => h.encoded !== undefined),
      },
    });
  }
}

/** `/workspaces/{id}/…` → the id. */
export function workspaceIdOfPath(path: string): string | undefined {
  const m = /^\/workspaces\/([^/]+)(?:\/|$)/.exec(path);
  return m === null ? undefined : decodeURIComponent(m[1]!);
}

// ------------------------------------------------------------------------------------------------ token vaults (14d)

export const DEFAULT_VAULT_RETENTION_DAYS = 30;

export function vaultRetentionDays(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env['XO_TOKEN_VAULT_RETENTION_DAYS'] ?? '').trim();
  if (raw === '') return DEFAULT_VAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('XO_TOKEN_VAULT_RETENTION_DAYS must be a whole number of days, 1 to 3650');
  return n;
}

const SCOPE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * A workspace's token vaults: `<data>/<ws>/token-vaults/<scope>.vault`, each sealed (AES-256-GCM) under a key derived from the
 * credentials master key for this workspace alone. Without the master key there are no vaults (the caller must not tokenise).
 */
export class TokenVaultStore {
  private readonly dir: string;
  private readonly key: Buffer;

  constructor(
    workspace: WorkspaceRecord,
    config: WorkspaceDataConfig,
    credentials: CredentialsConfig,
    private readonly retentionDays: number,
  ) {
    this.dir = vaultDir(config.dataRootDir, workspace.workspaceId);
    this.key = vaultKey(credentials.masterKey, workspace.workspaceId);
  }

  private path(scope: string): string {
    if (!SCOPE.test(scope)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a token vault scope is an id');
    return join(this.dir, `${scope}.vault`);
  }

  /** The workflow's vault: the stored one while it is in retention, otherwise a new, empty one (an expired one is erased). */
  async open(scope: string, now = new Date()): Promise<TokenVault> {
    let sealed: string;
    try {
      sealed = await readFile(this.path(scope), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return TokenVault.create(scope, now, this.retentionDays);
    }
    const vault = unsealVault(this.key, sealed);
    if (Date.parse(vault.expiresAt) <= now.getTime()) {
      await this.erase(scope);
      return TokenVault.create(scope, now, this.retentionDays);
    }
    return vault;
  }

  async save(vault: TokenVault): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.${vault.scope}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, sealVault(this.key, vault), { mode: 0o600 });
    await rename(tmp, this.path(vault.scope));
  }

  /** Erases a workflow's vault (its placeholders can no longer be turned back into values). */
  erase(scope: string): Promise<boolean> {
    return eraseVaultFile(this.path(scope));
  }
}

const vaultDir = (dataRootDir: string, workspaceId: string): string => join(dataRootDir, workspaceId, 'token-vaults');

async function eraseVaultFile(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Erases a workflow's vault. Needs no key, so archiving erases it even where connections are not configured. */
export function eraseTokenVault(dataRootDir: string, workspaceId: string, scope: string): Promise<boolean> {
  if (!SCOPE.test(scope)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a token vault scope is an id');
  return eraseVaultFile(join(vaultDir(dataRootDir, workspaceId), `${scope}.vault`));
}

/**
 * Erases every vault of a workspace past its retention, and any that cannot be read. Reads only the expiry written beside the
 * sealed box (no key needed); `open` checks the sealed expiry as well. Run by the scheduler on every tick. Returns how many.
 */
export async function sweepTokenVaults(dataRootDir: string, workspaceId: string, now = new Date()): Promise<number> {
  const dir = vaultDir(dataRootDir, workspaceId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let erased = 0;
  for (const name of names) {
    if (!name.endsWith('.vault')) continue;
    let expired: boolean;
    try {
      const box = JSON.parse(await readFile(join(dir, name), 'utf8')) as { expiresAt?: unknown };
      expired = typeof box.expiresAt !== 'string' || !(Date.parse(box.expiresAt) > now.getTime());
    } catch {
      expired = true;
    }
    if (expired && (await eraseVaultFile(join(dir, name)))) erased++;
  }
  return erased;
}
