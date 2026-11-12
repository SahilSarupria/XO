/**
 * Wire types and runtime parsers for the Connect HTTP contract v1 (packages/connect/docs/HTTP_CONTRACT.md).
 * Hand-declared and parsed, like every other wire model in Studio: a response that does not match the contract is `malformed`, never
 * rendered as truth. Studio imports no platform package.
 */
import { WireParseError, arr, bool, num, obj, optStr, str } from './wire';

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => {
  const s = str(v, path);
  if (!(allowed as readonly string[]).includes(s)) throw new WireParseError(path, `one of ${allowed.join(' | ')}`);
  return s as T;
};

export const SOURCE_STATES = [
  'awaiting_first_read',
  'read_complete',
  'read_partial',
  'needs_attention',
  'access_ended',
  'access_expired',
  'disconnected',
  'setup_incomplete',
  'unsupported',
] as const;
export type ConnectSourceState = (typeof SOURCE_STATES)[number];

export interface Attention {
  readonly code: string;
  readonly message: string;
}

export interface ReadReport {
  readonly requested: number;
  readonly read: number;
  readonly unreadable: number;
  readonly skipped: { readonly notIncluded: number; readonly notAcquirable: number; readonly vanished: number };
  readonly status: 'complete' | 'partial' | 'failed';
  readonly errorCodes: readonly string[];
  readonly evidence: 'retained' | 'not_retained';
  readonly retired: number;
  readonly assertionsAdded?: number;
  readonly notUnderstood?: number;
}

export interface HistoryEvent {
  readonly at: string;
  readonly kind: 'connected' | 'read' | 'selection_changed' | 'learned_removed' | 'disconnected' | 'reconnected';
  readonly read?: ReadReport;
  readonly includedItems?: number;
  readonly retired?: number;
}

export interface ConnectSource {
  readonly id: string;
  readonly kind: 'local_folder';
  readonly displayName: string;
  readonly state: ConnectSourceState;
  readonly lastReadAt?: string;
  readonly selection: { readonly includedItems: number; readonly excludedNames: number };
  readonly attention?: Attention;
  /** Present on a detail response only. Newest last. */
  readonly history?: readonly HistoryEvent[];
}

export interface ActionEffects {
  readonly futureReads: 'stopped' | 'narrowed' | 'widened' | 'resumed' | 'unchanged';
  readonly existingKnowledge: 'kept';
  readonly platformAuthorization: 'unchanged';
}
export interface ActionResult {
  readonly source: ConnectSource;
  readonly effects: ActionEffects;
}

export interface AddSourceEntry {
  readonly kind: 'local_folder' | 'microsoft_365' | 'google_workspace';
  readonly availability: 'available' | 'coming_soon';
  readonly note: string;
}

export interface ConnectDashboard {
  readonly connectedSources: number;
  readonly needsAttention: number;
  readonly knowledge: { readonly availability: 'not_available' | 'empty' | 'ready'; readonly reason: string };
}

export interface ConnectCapabilities {
  readonly viewSources: boolean;
  readonly manageSources: boolean;
  readonly readKnowledge: boolean;
  readonly reviewKnowledge: boolean;
}

export interface FolderEntry {
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly depth: number;
  readonly contentAcquirable: boolean;
}
export interface FolderPreview {
  readonly entries: readonly FolderEntry[];
  readonly truncated: boolean;
  readonly summary: {
    readonly files: number;
    readonly acquirableFiles: number;
    readonly totalBytes: number;
    readonly limitsHit: readonly string[];
  };
}

export interface RemovalPreview {
  readonly evidenceItems: number;
  readonly factDependencies: 'not_available';
}
export interface RemovalResult {
  readonly removed: true;
  readonly evidenceItemsRetired: number;
  readonly sourceFilesChanged: false;
}

function parseAttention(v: unknown, path: string): Attention | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, path);
  return { code: str(o['code'], `${path}.code`), message: str(o['message'], `${path}.message`) };
}

export function parseReadReport(v: unknown, path = 'read'): ReadReport {
  const o = obj(v, path);
  const sk = obj(o['skipped'], `${path}.skipped`);
  const assertionsAdded = o['assertionsAdded'] === undefined ? undefined : num(o['assertionsAdded'], `${path}.assertionsAdded`);
  const notUnderstood = o['notUnderstood'] === undefined ? undefined : num(o['notUnderstood'], `${path}.notUnderstood`);
  return {
    requested: num(o['requested'], `${path}.requested`),
    read: num(o['read'], `${path}.read`),
    unreadable: num(o['unreadable'], `${path}.unreadable`),
    skipped: {
      notIncluded: num(sk['notIncluded'], `${path}.skipped.notIncluded`),
      notAcquirable: num(sk['notAcquirable'], `${path}.skipped.notAcquirable`),
      vanished: num(sk['vanished'], `${path}.skipped.vanished`),
    },
    status: oneOf(o['status'], ['complete', 'partial', 'failed'], `${path}.status`),
    errorCodes: arr(o['errorCodes'], `${path}.errorCodes`).map((c, i) => str(c, `${path}.errorCodes[${i}]`)),
    evidence: oneOf(o['evidence'], ['retained', 'not_retained'], `${path}.evidence`),
    retired: num(o['retired'], `${path}.retired`),
    ...(assertionsAdded !== undefined ? { assertionsAdded } : {}),
    ...(notUnderstood !== undefined ? { notUnderstood } : {}),
  };
}

function parseHistory(v: unknown, path: string): HistoryEvent {
  const o = obj(v, path);
  const includedItems = o['includedItems'] === undefined ? undefined : num(o['includedItems'], `${path}.includedItems`);
  const retired = o['retired'] === undefined ? undefined : num(o['retired'], `${path}.retired`);
  return {
    at: str(o['at'], `${path}.at`),
    kind: oneOf(o['kind'], ['connected', 'read', 'selection_changed', 'learned_removed', 'disconnected', 'reconnected'], `${path}.kind`),
    ...(o['read'] !== undefined ? { read: parseReadReport(o['read'], `${path}.read`) } : {}),
    ...(includedItems !== undefined ? { includedItems } : {}),
    ...(retired !== undefined ? { retired } : {}),
  };
}

export function parseConnectSource(v: unknown, path = 'source'): ConnectSource {
  const o = obj(v, path);
  if (o['readOnly'] !== true) throw new WireParseError(`${path}.readOnly`, 'true');
  const sel = obj(o['selection'], `${path}.selection`);
  const attention = parseAttention(o['attention'], `${path}.attention`);
  const lastReadAt = optStr(o['lastReadAt'], `${path}.lastReadAt`);
  return {
    id: str(o['id'], `${path}.id`),
    kind: oneOf(o['kind'], ['local_folder'], `${path}.kind`),
    displayName: str(o['displayName'], `${path}.displayName`),
    state: oneOf(o['state'], SOURCE_STATES, `${path}.state`),
    selection: {
      includedItems: num(sel['includedItems'], `${path}.selection.includedItems`),
      excludedNames: num(sel['excludedNames'], `${path}.selection.excludedNames`),
    },
    ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    ...(attention !== undefined ? { attention } : {}),
    ...(o['history'] !== undefined
      ? { history: arr(o['history'], `${path}.history`).map((h, i) => parseHistory(h, `${path}.history[${i}]`)) }
      : {}),
  };
}

export const parseConnectSourceList = (v: unknown): ConnectSource[] =>
  arr(obj(v, 'body')['sources'], 'sources').map((s, i) => parseConnectSource(s, `sources[${i}]`));

export function parseActionResult(v: unknown): ActionResult {
  const o = obj(v, 'body');
  const e = obj(o['effects'], 'effects');
  if (e['existingKnowledge'] !== 'kept') throw new WireParseError('effects.existingKnowledge', '"kept"');
  if (e['platformAuthorization'] !== 'unchanged') throw new WireParseError('effects.platformAuthorization', '"unchanged"');
  return {
    source: parseConnectSource(o['source'], 'source'),
    effects: {
      futureReads: oneOf(e['futureReads'], ['stopped', 'narrowed', 'widened', 'resumed', 'unchanged'], 'effects.futureReads'),
      existingKnowledge: 'kept',
      platformAuthorization: 'unchanged',
    },
  };
}

export const parseCatalog = (v: unknown): AddSourceEntry[] =>
  arr(obj(v, 'body')['sources'], 'sources').map((s, i) => {
    const o = obj(s, `sources[${i}]`);
    return {
      kind: oneOf(o['kind'], ['local_folder', 'microsoft_365', 'google_workspace'], `sources[${i}].kind`),
      availability: oneOf(o['availability'], ['available', 'coming_soon'], `sources[${i}].availability`),
      note: str(o['note'], `sources[${i}].note`),
    };
  });

export function parseConnectDashboard(v: unknown): ConnectDashboard {
  const o = obj(v, 'body');
  const k = obj(o['knowledge'], 'knowledge');
  return {
    connectedSources: num(o['connectedSources'], 'connectedSources'),
    needsAttention: num(o['needsAttention'], 'needsAttention'),
    knowledge: {
      availability: oneOf(k['availability'], ['not_available', 'empty', 'ready'], 'knowledge.availability'),
      reason: str(k['reason'], 'knowledge.reason'),
    },
  };
}

export function parseConnectCapabilities(v: unknown): ConnectCapabilities {
  const o = obj(v, 'body');
  return {
    viewSources: bool(o['viewSources'], 'viewSources'),
    manageSources: bool(o['manageSources'], 'manageSources'),
    readKnowledge: bool(o['readKnowledge'], 'readKnowledge'),
    reviewKnowledge: bool(o['reviewKnowledge'], 'reviewKnowledge'),
  };
}

export function parseFolderPreview(v: unknown): FolderPreview {
  const o = obj(v, 'body');
  if (o['listingOnly'] !== true) throw new WireParseError('listingOnly', 'true');
  const s = obj(o['summary'], 'summary');
  return {
    entries: arr(o['entries'], 'entries').map((e, i) => {
      const x = obj(e, `entries[${i}]`);
      return {
        key: str(x['key'], `entries[${i}].key`),
        name: str(x['name'], `entries[${i}].name`),
        extension: str(x['extension'], `entries[${i}].extension`),
        sizeBytes: num(x['sizeBytes'], `entries[${i}].sizeBytes`),
        modifiedAt: str(x['modifiedAt'], `entries[${i}].modifiedAt`),
        depth: num(x['depth'], `entries[${i}].depth`),
        contentAcquirable: bool(x['contentAcquirable'], `entries[${i}].contentAcquirable`),
      };
    }),
    truncated: bool(o['truncated'], 'truncated'),
    summary: {
      files: num(s['files'], 'summary.files'),
      acquirableFiles: num(s['acquirableFiles'], 'summary.acquirableFiles'),
      totalBytes: num(s['totalBytes'], 'summary.totalBytes'),
      limitsHit: arr(s['limitsHit'], 'summary.limitsHit').map((l, i) => str(l, `summary.limitsHit[${i}]`)),
    },
  };
}

export function parseRemovalPreview(v: unknown): RemovalPreview {
  const o = obj(v, 'body');
  if (o['factDependencies'] !== 'not_available') throw new WireParseError('factDependencies', '"not_available"');
  return { evidenceItems: num(o['evidenceItems'], 'evidenceItems'), factDependencies: 'not_available' };
}

export function parseRemovalResult(v: unknown): RemovalResult {
  const o = obj(v, 'body');
  if (o['removed'] !== true) throw new WireParseError('removed', 'true');
  if (o['sourceFilesChanged'] !== false) throw new WireParseError('sourceFilesChanged', 'false');
  return { removed: true, evidenceItemsRetired: num(o['evidenceItemsRetired'], 'evidenceItemsRetired'), sourceFilesChanged: false };
}

export interface SourceFolderView {
  readonly preview: FolderPreview;
  readonly selectedKeys: readonly string[];
  readonly excludedNames: readonly string[];
}
export function parseSourceFolderView(v: unknown): SourceFolderView {
  const o = obj(v, 'body');
  return {
    preview: parseFolderPreview(o['preview']),
    selectedKeys: arr(o['selectedKeys'], 'selectedKeys').map((k, i) => str(k, `selectedKeys[${i}]`)),
    excludedNames: arr(o['excludedNames'], 'excludedNames').map((k, i) => str(k, `excludedNames[${i}]`)),
  };
}

export interface ItemRemovalResult {
  readonly removed: true;
  readonly evidenceItemsRetired: number;
  readonly itemsNoLongerRead: number;
  readonly sourceFilesChanged: false;
  readonly source: ConnectSource;
}
export function parseItemRemovalResult(v: unknown): ItemRemovalResult {
  const o = obj(v, 'body');
  if (o['removed'] !== true) throw new WireParseError('removed', 'true');
  if (o['sourceFilesChanged'] !== false) throw new WireParseError('sourceFilesChanged', 'false');
  return {
    removed: true,
    evidenceItemsRetired: num(o['evidenceItemsRetired'], 'evidenceItemsRetired'),
    itemsNoLongerRead: num(o['itemsNoLongerRead'], 'itemsNoLongerRead'),
    sourceFilesChanged: false,
    source: parseConnectSource(o['source'], 'source'),
  };
}
