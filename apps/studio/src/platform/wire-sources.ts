/**
 * UW-12a — workspace source connections (`/workspaces/{ws}/source-connections`, docs/SOURCE_CONNECTIONS.md) as Studio reads them.
 * Everything is checked: a field that breaks the contract makes the whole answer a problem, never half-shown data.
 */
import { WireParseError, arr, bool, num, obj, optStr, str, strArr } from './wire';

export type SourceConnectionKind = 'local_folder' | 'agent_folder' | 'microsoft_drive' | 'google_drive';
export const SOURCE_CONNECTION_KINDS: readonly SourceConnectionKind[] = ['local_folder', 'agent_folder', 'microsoft_drive', 'google_drive'];
export type DriveProvider = 'microsoft' | 'google';

export type Freshness =
  | { readonly state: 'never_synced' }
  | { readonly state: 'current'; readonly asOf: string }
  | { readonly state: 'stale'; readonly asOf: string; readonly dueSince: string }
  | { readonly state: 'needs_attention'; readonly asOf?: string; readonly problem: string }
  | { readonly state: 'paused'; readonly asOf?: string }
  | { readonly state: 'retired'; readonly at: string };

export interface SyncReport {
  readonly at: string;
  readonly outcome: 'complete' | 'partial' | 'failed';
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly failed: Readonly<Record<string, number>>;
  readonly skipped: Readonly<Record<string, number>>;
  readonly truncated?: string;
  readonly problem?: string;
}

export interface AgentView {
  readonly paired: boolean;
  readonly label?: string;
  readonly platform?: string;
  readonly pairedAt?: string;
  readonly pairingExpiresAt?: string;
  readonly syncRequestedAt?: string;
  readonly lastSeenAt?: string;
}

export interface SourceConnectionSummary {
  readonly connectionId: string;
  readonly kind: SourceConnectionKind;
  readonly displayName: string;
  readonly sync: { readonly mode: 'manual' } | { readonly mode: 'interval'; readonly everyMinutes: number };
  readonly paused: boolean;
  readonly remote?: { readonly provider: DriveProvider; readonly credentialId: string };
  readonly agent?: AgentView;
  readonly retiredAt?: string;
  readonly freshness: Freshness;
  readonly revision: number;
  readonly files: number;
  readonly lastSync?: SyncReport;
}

export interface SourceConnectionItem {
  readonly key: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export interface ConnectionProposal {
  readonly proposalId: string;
  readonly role: string;
  readonly label: string;
  readonly basis: readonly string[];
  readonly strength: 'strong' | 'weak';
  readonly status: 'proposed' | 'confirmed' | 'rejected';
  readonly changedSinceDecision: boolean;
}

export interface SourceConnectionDetail extends SourceConnectionSummary {
  readonly items: readonly SourceConnectionItem[];
  readonly proposals: readonly ConnectionProposal[];
}

export interface Pairing {
  readonly code: string;
  readonly expiresAt: string;
}

export interface SourceConnectionOptions {
  readonly localFolder: { readonly available: boolean };
  readonly drives: readonly {
    readonly provider: DriveProvider;
    readonly kind: 'microsoft_drive' | 'google_drive';
    readonly displayName: string;
    readonly available: boolean;
    readonly reason?: string;
  }[];
  readonly agent: { readonly available: boolean; readonly serverAddress?: string };
}

export interface DriveFolder {
  readonly ref: string;
  readonly name: string;
  readonly kind: 'drive' | 'folder';
}

export interface DriveAccount {
  readonly credentialId: string;
  readonly provider: DriveProvider;
  readonly accountLabel?: string;
  readonly state: string;
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new WireParseError(path, allowed.join(' | '));
  return v as T;
};

const counts = (v: unknown, path: string): Record<string, number> => {
  if (v === undefined) return {};
  const o = obj(v, path);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(o)) if (n !== undefined) out[k] = num(n, `${path}.${k}`);
  return out;
};

function parseFreshness(v: unknown, path: string): Freshness {
  const o = obj(v, path);
  const state = oneOf(o['state'], ['never_synced', 'current', 'stale', 'needs_attention', 'paused', 'retired'] as const, `${path}.state`);
  const asOf = optStr(o['asOf'], `${path}.asOf`);
  switch (state) {
    case 'never_synced':
      return { state };
    case 'current':
      return { state, asOf: str(o['asOf'], `${path}.asOf`) };
    case 'stale':
      return { state, asOf: str(o['asOf'], `${path}.asOf`), dueSince: str(o['dueSince'], `${path}.dueSince`) };
    case 'needs_attention':
      return { state, problem: str(o['problem'], `${path}.problem`), ...(asOf !== undefined ? { asOf } : {}) };
    case 'paused':
      return { state, ...(asOf !== undefined ? { asOf } : {}) };
    case 'retired':
      return { state, at: str(o['at'], `${path}.at`) };
  }
}

function parseSync(v: unknown, path: string): SourceConnectionSummary['sync'] {
  const o = obj(v, path);
  const mode = oneOf(o['mode'], ['manual', 'interval'] as const, `${path}.mode`);
  return mode === 'manual' ? { mode } : { mode, everyMinutes: num(o['everyMinutes'], `${path}.everyMinutes`) };
}

function parseReport(v: unknown, path: string): SyncReport {
  const o = obj(v, path);
  const truncated = optStr(o['truncated'], `${path}.truncated`);
  const problem = optStr(o['problem'], `${path}.problem`);
  return {
    at: str(o['at'], `${path}.at`),
    outcome: oneOf(o['outcome'], ['complete', 'partial', 'failed'] as const, `${path}.outcome`),
    added: num(o['added'], `${path}.added`),
    changed: num(o['changed'], `${path}.changed`),
    unchanged: num(o['unchanged'], `${path}.unchanged`),
    removed: num(o['removed'], `${path}.removed`),
    failed: counts(o['failed'], `${path}.failed`),
    skipped: counts(o['skipped'], `${path}.skipped`),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(problem !== undefined ? { problem } : {}),
  };
}

function parseAgent(v: unknown, path: string): AgentView {
  const o = obj(v, path);
  const opt = (k: string) => optStr(o[k], `${path}.${k}`);
  const fields = ['label', 'platform', 'pairedAt', 'pairingExpiresAt', 'syncRequestedAt', 'lastSeenAt'] as const;
  const out: Record<string, unknown> = { paired: bool(o['paired'], `${path}.paired`) };
  for (const k of fields) {
    const x = opt(k);
    if (x !== undefined) out[k] = x;
  }
  return out as unknown as AgentView;
}

export function parseConnectionSummary(v: unknown, path = 'connection'): SourceConnectionSummary {
  const o = obj(v, path);
  const remote = o['remote'] === undefined ? undefined : obj(o['remote'], `${path}.remote`);
  const retiredAt = optStr(o['retiredAt'], `${path}.retiredAt`);
  return {
    connectionId: str(o['connectionId'], `${path}.connectionId`),
    kind: oneOf(o['kind'], SOURCE_CONNECTION_KINDS, `${path}.kind`),
    displayName: str(o['displayName'], `${path}.displayName`),
    sync: parseSync(o['sync'], `${path}.sync`),
    paused: bool(o['paused'], `${path}.paused`),
    ...(remote !== undefined
      ? {
          remote: {
            provider: oneOf(remote['provider'], ['microsoft', 'google'] as const, `${path}.remote.provider`),
            credentialId: str(remote['credentialId'], `${path}.remote.credentialId`),
          },
        }
      : {}),
    ...(o['agent'] !== undefined ? { agent: parseAgent(o['agent'], `${path}.agent`) } : {}),
    ...(retiredAt !== undefined ? { retiredAt } : {}),
    freshness: parseFreshness(o['freshness'], `${path}.freshness`),
    revision: num(o['revision'], `${path}.revision`),
    files: typeof o['files'] === 'number' ? o['files'] : arr(o['items'], `${path}.items`).length,
    ...(o['lastSync'] !== undefined ? { lastSync: parseReport(o['lastSync'], `${path}.lastSync`) } : {}),
  };
}

export function parseConnectionDetail(v: unknown, path = 'connection'): SourceConnectionDetail {
  const o = obj(v, path);
  const summary = parseConnectionSummary({ ...o, files: arr(o['items'], `${path}.items`).length }, path);
  return {
    ...summary,
    items: arr(o['items'], `${path}.items`).map((x, i) => {
      const it = obj(x, `${path}.items[${i}]`);
      return {
        key: str(it['key'], `${path}.items[${i}].key`),
        name: str(it['name'], `${path}.items[${i}].name`),
        sizeBytes: num(it['sizeBytes'], `${path}.items[${i}].sizeBytes`),
        modifiedAt: str(it['modifiedAt'], `${path}.items[${i}].modifiedAt`),
      };
    }),
    proposals: arr(o['proposals'], `${path}.proposals`).map((x, i) => {
      const p = obj(x, `${path}.proposals[${i}]`);
      const at = `${path}.proposals[${i}]`;
      return {
        proposalId: str(p['proposalId'], `${at}.proposalId`),
        role: str(p['role'], `${at}.role`),
        label: str(p['label'], `${at}.label`),
        basis: strArr(p['basis'], `${at}.basis`),
        strength: p['strength'] === 'strong' ? 'strong' : 'weak',
        status: oneOf(p['status'], ['proposed', 'confirmed', 'rejected'] as const, `${at}.status`),
        changedSinceDecision: p['changedSinceDecision'] === true,
      };
    }),
  };
}

export function parseConnectionList(v: unknown): SourceConnectionSummary[] {
  return arr(obj(v, 'body')['connections'], 'connections').map((x, i) => parseConnectionSummary(x, `connections[${i}]`));
}

export function parseConnectionAnswer(v: unknown): { readonly connection: SourceConnectionDetail; readonly pairing?: Pairing } {
  const o = obj(v, 'body');
  const pairing = o['pairing'] === undefined ? undefined : obj(o['pairing'], 'pairing');
  return {
    connection: parseConnectionDetail(o['connection']),
    ...(pairing !== undefined
      ? { pairing: { code: str(pairing['code'], 'pairing.code'), expiresAt: str(pairing['expiresAt'], 'pairing.expiresAt') } }
      : {}),
  };
}

export function parseConnectionOptions(v: unknown): SourceConnectionOptions {
  const o = obj(v, 'body');
  const agent = obj(o['agent'], 'agent');
  const server = optStr(agent['serverAddress'], 'agent.serverAddress');
  return {
    localFolder: { available: bool(obj(o['localFolder'], 'localFolder')['available'], 'localFolder.available') },
    drives: arr(o['drives'], 'drives').map((x, i) => {
      const d = obj(x, `drives[${i}]`);
      const reason = optStr(d['reason'], `drives[${i}].reason`);
      return {
        provider: oneOf(d['provider'], ['microsoft', 'google'] as const, `drives[${i}].provider`),
        kind: oneOf(d['kind'], ['microsoft_drive', 'google_drive'] as const, `drives[${i}].kind`),
        displayName: str(d['displayName'], `drives[${i}].displayName`),
        available: bool(d['available'], `drives[${i}].available`),
        ...(reason !== undefined ? { reason } : {}),
      };
    }),
    agent: { available: bool(agent['available'], 'agent.available'), ...(server !== undefined ? { serverAddress: server } : {}) },
  };
}

export function parseDriveFolders(v: unknown): DriveFolder[] {
  return arr(obj(v, 'body')['folders'], 'folders').map((x, i) => {
    const f = obj(x, `folders[${i}]`);
    return {
      ref: str(f['ref'], `folders[${i}].ref`),
      name: str(f['name'], `folders[${i}].name`),
      kind: oneOf(f['kind'], ['drive', 'folder'] as const, `folders[${i}].kind`),
    };
  });
}

/** The workspace's accounts that can read files (capability files.read). Anything else in the list is left out. */
export function parseDriveAccounts(v: unknown): DriveAccount[] {
  return arr(obj(v, 'body')['credentials'], 'credentials').flatMap((x, i) => {
    const c = obj(x, `credentials[${i}]`);
    const provider = c['provider'];
    if (provider !== 'microsoft' && provider !== 'google') return [];
    if (!strArr(c['capabilities'], `credentials[${i}].capabilities`).includes('files.read')) return [];
    const label = optStr(c['accountLabel'], `credentials[${i}].accountLabel`);
    return [
      {
        credentialId: str(c['credentialId'], `credentials[${i}].credentialId`),
        provider,
        state: str(c['state'], `credentials[${i}].state`),
        ...(label !== undefined ? { accountLabel: label } : {}),
      },
    ];
  });
}

export function parseConsent(v: unknown): { readonly authorizationUrl: string; readonly expiresAt: string } {
  const o = obj(v, 'body');
  const url = str(o['authorizationUrl'], 'authorizationUrl');
  // Only a provider's own sign-in page, over https: a link Studio shows must not point anywhere else.
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('not https');
    host = u.hostname;
  } catch {
    throw new WireParseError('authorizationUrl', 'an https address');
  }
  if (host !== 'accounts.google.com' && host !== 'login.microsoftonline.com')
    throw new WireParseError('authorizationUrl', "the provider's sign-in page");
  return { authorizationUrl: url, expiresAt: str(o['expiresAt'], 'expiresAt') };
}
