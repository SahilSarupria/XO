import { isAuthenticatedPrincipal, type AuthenticatedPrincipal } from '@xo/permissions';
import {
  MAX_EXCLUDED_NAMES,
  MAX_HISTORY,
  MAX_INCLUDE_KEYS,
  MAX_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ROOT_LENGTH,
  failResult,
  okResult,
  type ActionEffects,
  type ActionResult,
  type Capabilities,
  type AddSourceEntry,
  type ConnectFolderRequest,
  type ConnectResult,
  type ItemRemovalRequest,
  type ItemRemovalResult,
  MAX_REMOVAL_ITEMS,
  type RemovalPreview,
  type SourceFolderView,
  type RemovalResult,
  type DashboardSummary,
  type FolderPreview,
  type HistoryEvent,
  type PreviewFolderRequest,
  type ReadReport,
  type SourceCard,
  type SourceDetail,
  type UpdateSelectionRequest,
} from './contract.js';
import {
  EMPTY_STATE,
  configKey,
  type CapabilityProbe,
  type ConnectState,
  type ConnectStateStore,
  type LocalFolderBackend,
  type SourceConfig,
} from './ports.js';
import { deriveState } from './state.js';
import type { KnowledgePort, KnowledgeReviewResponse, KnowledgeSearchRequest, KnowledgeSearchResponse } from './knowledge.js';

export interface ConnectClock {
  now(): Date;
}

export interface ConnectServiceOptions {
  readonly backend: LocalFolderBackend;
  readonly store: ConnectStateStore;
  readonly clock?: ConnectClock;
  /** Asks the platform gate what the caller may do. When supplied, listing needs `viewSources` and every change or read needs `manageSources`; denial or failure refuses. */
  readonly access?: CapabilityProbe;
  /**
   * Whether this host may read folders on ITS OWN machine. Off unless the host says so: a hosted API cannot see a user's computer, and
   * must not let users point it at paths on the server's disk. When off, the catalog says folder reading needs the desktop connection and
   * every folder operation is refused as `unavailable` before anything is listed or read.
   */
  readonly localFolders?: boolean;
  /** Read-only knowledge (C6 SDK). Absent when the host has no durable state: then knowledge is reported as not available. */
  readonly knowledge?: KnowledgePort;
}

/** The interface-neutral surface. Every method runs as one authenticated principal and can only address that principal's own sources. */
export interface ConnectService {
  catalog(): readonly AddSourceEntry[];
  capabilities(principal: AuthenticatedPrincipal): Promise<ConnectResult<Capabilities>>;
  /** C6 retrieval, unchanged: what the caller may see, with evidence references and uncertainty. Reads nothing from sources. */
  searchKnowledge(principal: AuthenticatedPrincipal, request: KnowledgeSearchRequest): Promise<ConnectResult<KnowledgeSearchResponse>>;
  /** C6 review queue (conflicts, single-source inferences, weak merges). Read-only; deciding is separate, gated work. */
  knowledgeReviewQueue(principal: AuthenticatedPrincipal, asOf?: string): Promise<ConnectResult<KnowledgeReviewResponse>>;
  dashboard(principal: AuthenticatedPrincipal): Promise<ConnectResult<DashboardSummary>>;
  listSources(principal: AuthenticatedPrincipal): Promise<ConnectResult<readonly SourceCard[]>>;
  getSource(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<SourceDetail>>;
  previewFolder(principal: AuthenticatedPrincipal, request: PreviewFolderRequest): Promise<ConnectResult<FolderPreview>>;
  /** Re-lists a connected folder (through the platform gate) with the current selection, so it can be changed. Reads no content. */
  previewSource(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<SourceFolderView>>;
  connectFolder(principal: AuthenticatedPrincipal, request: ConnectFolderRequest): Promise<ConnectResult<ActionResult>>;
  updateSelection(
    principal: AuthenticatedPrincipal,
    sourceId: string,
    request: UpdateSelectionRequest,
  ): Promise<ConnectResult<ActionResult>>;
  /** Re-lists the folder through the platform gate so a source with no current platform record (for example after a restart) is re-established. Reads no content. */
  checkSource(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<ActionResult>>;
  readNow(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<ActionResult>>;
  /** What removing the source would retire. Changes nothing. */
  previewRemoval(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<RemovalPreview>>;
  /**
   * Removes the source and what XO retained from it: evidence is revoked then purged first (so it is ineligible immediately), and only
   * then is the source forgotten. Files in the folder are never touched. This is source-wide; removing one item's evidence is separate work.
   */
  removeSource(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<RemovalResult>>;
  /**
   * "Remove what XO learned" for chosen items: takes them out of the chosen set first (so no read learns them again), then retires what
   * XO kept from them. Separate from excluding (which keeps what was learned) and from removing the whole source. Files are never touched.
   */
  removeLearned(
    principal: AuthenticatedPrincipal,
    sourceId: string,
    request: ItemRemovalRequest,
  ): Promise<ConnectResult<ItemRemovalResult>>;
  disconnect(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<ActionResult>>;
  reconnect(principal: AuthenticatedPrincipal, sourceId: string): Promise<ConnectResult<ActionResult>>;
}

export const LOCAL_FOLDER_UNAVAILABLE_NOTE =
  'Reading folders on your computer needs the XO desktop connection, which is not available in this deployment yet.';

export const CATALOG: readonly AddSourceEntry[] = Object.freeze([
  Object.freeze({
    kind: 'local_folder',
    availability: 'available',
    note: 'Needs the XO desktop connection. XO reads only the items you choose and never changes them.',
  }),
  Object.freeze({
    kind: 'microsoft_365',
    availability: 'coming_soon',
    note: 'Coming soon. Reading files from Microsoft 365 is not available yet.',
  }),
  Object.freeze({
    kind: 'google_workspace',
    availability: 'coming_soon',
    note: 'Coming soon. Reading files from Google Workspace is not available yet.',
  }),
] as AddSourceEntry[]);

// -- validation --------------------------------------------------------------------------------------------------------

const hasNul = (s: string): boolean => s.includes('\0');

function validRoot(root: unknown): root is string {
  return (
    typeof root === 'string' &&
    root.length > 0 &&
    root.length <= MAX_ROOT_LENGTH &&
    !hasNul(root) &&
    root.startsWith('/') &&
    !root.split('/').some((seg) => seg === '..')
  );
}

function validKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || hasNul(key) || key.startsWith('/')) return false;
  return !key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    !hasNul(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  );
}

function cleanNames(names: unknown): readonly string[] | undefined {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > MAX_EXCLUDED_NAMES || !names.every(validName)) return undefined;
  return [...new Set(names as string[])].sort();
}

function cleanKeys(keys: unknown): readonly string[] | undefined {
  if (!Array.isArray(keys) || keys.length > MAX_INCLUDE_KEYS || !keys.every(validKey)) return undefined;
  return [...new Set(keys as string[])].sort();
}

/** True when any path segment of `key` is an excluded name. Exclusion wins over inclusion. */
const excludedByName = (key: string, names: ReadonlySet<string>): boolean => key.split('/').some((seg) => names.has(seg));

const baseName = (root: string): string => {
  const parts = root.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? 'folder';
};

const NOT_FOUND = <T>(): ConnectResult<T> => failResult('not_found', 'that source was not found');
const UNAVAILABLE = <T>(): ConnectResult<T> => failResult('unavailable', 'Connect state is unavailable; nothing was changed', true);

// -- service -----------------------------------------------------------------------------------------------------------

export function createConnectService(options: ConnectServiceOptions): ConnectService {
  const { backend, store } = options;
  const clock: ConnectClock = options.clock ?? { now: () => new Date() };
  const localFolders = options.localFolders === true;
  const NO_LOCAL = <T>(): ConnectResult<T> => failResult('unavailable', LOCAL_FOLDER_UNAVAILABLE_NOTE);

  // Mutations are serialized so two requests cannot lose each other's update (the store replaces the whole state).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const reading = new Set<string>();

  const authed = (p: unknown): p is AuthenticatedPrincipal => isAuthenticatedPrincipal(p);
  /** Fail closed: with a probe configured, a missing capability or a failed probe refuses before anything else happens. */
  const gate = async (p: AuthenticatedPrincipal, need: 'viewSources' | 'manageSources'): Promise<ConnectResult<never> | undefined> => {
    if (options.access === undefined) return undefined;
    const caps = await options.access.probe(p);
    if (!caps.ok) return caps;
    return caps.value[need] ? undefined : failResult('denied', 'the principal is not authorized for this operation');
  };
  const unauth = <T>(): ConnectResult<T> => failResult('unauthenticated', 'an authenticated principal is required');

  const knowledgeStatus = (): DashboardSummary['knowledge'] => {
    const k = options.knowledge;
    if (k === undefined)
      return { availability: 'not_available', reason: 'This host does not keep what it reads, so no knowledge is built.' };
    return k.assertionCount() > 0
      ? { availability: 'ready', reason: 'Knowledge is available from what XO has read.' }
      : {
          availability: 'empty',
          reason:
            'No knowledge yet. XO keeps what it reads, but only structured organizational records become knowledge today. After a restart, read a source again to rebuild.',
        };
  };

  const loadState = async (): Promise<ConnectState | undefined> => {
    try {
      return await store.load();
    } catch {
      return undefined;
    }
  };

  const card = (c: SourceConfig): SourceCard => {
    const d = deriveState(c, backend.facts(c.sourceId));
    return {
      id: c.sourceId,
      kind: 'local_folder',
      displayName: baseName(c.root),
      state: d.state,
      readOnly: true,
      ...(c.lastReadAt !== undefined ? { lastReadAt: c.lastReadAt } : {}),
      selection: { includedItems: c.includeKeys.length, excludedNames: c.excludedNames.length },
      ...(d.attention !== undefined ? { attention: d.attention } : {}),
      dataProvenance: 'live',
    };
  };
  const detail = (c: SourceConfig): SourceDetail => ({ ...card(c), history: c.history });

  const own = (state: ConnectState, p: AuthenticatedPrincipal, sourceId: string): SourceConfig | undefined =>
    typeof sourceId === 'string' ? state.sources[configKey(p.id, sourceId)] : undefined;

  /** Writes `next` for one source. Returns false when persistence failed (callers report `unavailable`; nothing is half-applied). */
  const persist = async (state: ConnectState, next: SourceConfig): Promise<boolean> => {
    try {
      await store.save({ version: 1, sources: { ...state.sources, [configKey(next.ownerId, next.sourceId)]: next } });
      return true;
    } catch {
      return false;
    }
  };
  const withEvent = (c: SourceConfig, event: HistoryEvent): readonly HistoryEvent[] => [...c.history, event].slice(-MAX_HISTORY);
  const effects = (futureReads: ActionEffects['futureReads']): ActionEffects => ({
    futureReads,
    existingKnowledge: 'kept',
    platformAuthorization: 'unchanged',
  });

  const checkSelection = (
    includeKeys: unknown,
    excludedNames: unknown,
  ): ConnectResult<{ readonly keys: readonly string[]; readonly names: readonly string[] }> => {
    const keys = cleanKeys(includeKeys);
    if (keys === undefined) return failResult('invalid_request', 'the chosen items are not valid');
    if (keys.length === 0) return failResult('invalid_request', 'nothing is chosen: pick at least one item');
    const names = cleanNames(excludedNames);
    if (names === undefined) return failResult('invalid_request', 'the excluded names are not valid');
    return okResult({ keys, names });
  };

  const unknownKeys = (keys: readonly string[], listing: { readonly entries: readonly { readonly key: string }[] }): boolean => {
    const present = new Set(listing.entries.map((e) => e.key));
    return keys.some((k) => !present.has(k));
  };

  return {
    catalog: () =>
      localFolders
        ? CATALOG
        : CATALOG.map((e) =>
            e.kind === 'local_folder' ? { kind: e.kind, availability: 'coming_soon' as const, note: LOCAL_FOLDER_UNAVAILABLE_NOTE } : e,
          ),

    async searchKnowledge(p, request) {
      if (!authed(p)) return unauth();
      if (options.knowledge === undefined) return failResult('unavailable', 'knowledge is not available on this host');
      return options.knowledge.search(p, request);
    },

    async knowledgeReviewQueue(p, asOf) {
      if (!authed(p)) return unauth();
      if (options.knowledge === undefined) return failResult('unavailable', 'knowledge is not available on this host');
      return options.knowledge.reviewQueue(p, asOf);
    },

    async capabilities(p) {
      if (!authed(p)) return unauth();
      if (options.access === undefined) return failResult('unavailable', 'no authorization gate is configured for Connect');
      return options.access.probe(p);
    },

    async listSources(p) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'viewSources');
        if (g) return g;
      }
      const state = await loadState();
      if (state === undefined) return UNAVAILABLE();
      const cards = Object.values(state.sources)
        .filter((c) => c.ownerId === p.id)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.sourceId < b.sourceId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
        .map(card);
      return okResult(cards);
    },

    async dashboard(p) {
      const listed = await this.listSources(p);
      if (!listed.ok) return listed;
      const active = listed.value.filter((c) => c.state !== 'disconnected' && c.state !== 'setup_incomplete' && c.state !== 'unsupported');
      return okResult({
        connectedSources: active.length,
        needsAttention: listed.value.filter(
          (c) => c.state === 'needs_attention' || c.state === 'access_ended' || c.state === 'read_partial',
        ).length,
        knowledge: knowledgeStatus(),
        dataProvenance: 'live',
      });
    },

    async getSource(p, sourceId) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'viewSources');
        if (g) return g;
      }
      const state = await loadState();
      if (state === undefined) return UNAVAILABLE();
      const c = own(state, p, sourceId);
      return c === undefined ? NOT_FOUND() : okResult(detail(c));
    },

    async previewFolder(p, request) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      if (request === null || typeof request !== 'object' || !validRoot(request.root))
        return failResult('invalid_request', 'the folder is not valid');
      const names = cleanNames(request.excludedNames);
      if (names === undefined) return failResult('invalid_request', 'the excluded names are not valid');
      const listing = await backend.list(p, { root: request.root, excludedNames: names });
      if (!listing.ok) return listing;
      const l = listing.value;
      return okResult({
        entries: l.entries,
        truncated: l.truncated,
        summary: {
          files: l.entries.length,
          acquirableFiles: l.entries.filter((e) => e.contentAcquirable).length,
          totalBytes: l.totalBytes,
          skippedByReason: l.skippedByReason,
          limitsHit: l.limitsHit,
        },
        listingOnly: true,
      });
    },

    async previewSource(p, sourceId) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const state = await loadState();
      if (state === undefined) return UNAVAILABLE();
      const c = own(state, p, sourceId);
      if (c === undefined) return NOT_FOUND();
      if (c.disconnected) return failResult('conflict', 'this source is disconnected; reconnect it before changing what it reads');
      const preview = await this.previewFolder(p, { root: c.root, excludedNames: c.excludedNames });
      if (!preview.ok) return preview;
      return okResult({ preview: preview.value, selectedKeys: c.includeKeys, excludedNames: c.excludedNames });
    },

    async connectFolder(p, request) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      if (request === null || typeof request !== 'object' || !validRoot(request.root))
        return failResult('invalid_request', 'the folder is not valid');
      const sel = checkSelection(request.includeKeys, request.excludedNames);
      if (!sel.ok) return sel;
      const listing = await backend.list(p, { root: request.root, excludedNames: sel.value.names });
      if (!listing.ok) return listing;
      if (unknownKeys(sel.value.keys, listing.value)) return failResult('invalid_request', 'some chosen items are not in the folder');
      return serial(async () => {
        const state = await loadState();
        if (state === undefined) return UNAVAILABLE<ActionResult>();
        if (own(state, p, listing.value.sourceId) !== undefined)
          return failResult<ActionResult>('conflict', 'this folder is already connected; change its selection instead');
        const at = clock.now().toISOString();
        const config: SourceConfig = {
          ownerId: p.id,
          sourceId: listing.value.sourceId,
          root: request.root,
          includeKeys: sel.value.keys,
          excludedNames: sel.value.names,
          disconnected: false,
          createdAt: at,
          history: [{ at, kind: 'connected', includedItems: sel.value.keys.length }],
        };
        if (!(await persist(state, config))) return UNAVAILABLE<ActionResult>();
        return okResult({ source: detail(config), effects: effects('unchanged') });
      });
    },

    async updateSelection(p, sourceId, request) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      if (request === null || typeof request !== 'object') return failResult('invalid_request', 'the request is not valid');
      const sel = checkSelection(request.includeKeys, request.excludedNames);
      if (!sel.ok) return sel;
      const first = await loadState();
      if (first === undefined) return UNAVAILABLE();
      const existing = own(first, p, sourceId);
      if (existing === undefined) return NOT_FOUND();
      const listing = await backend.list(p, { root: existing.root, excludedNames: sel.value.names });
      if (!listing.ok) return listing;
      if (unknownKeys(sel.value.keys, listing.value)) return failResult('invalid_request', 'some chosen items are not in the folder');
      return serial(async () => {
        const state = await loadState();
        if (state === undefined) return UNAVAILABLE<ActionResult>();
        const c = own(state, p, sourceId);
        if (c === undefined) return NOT_FOUND<ActionResult>();
        const before = new Set(c.includeKeys);
        const added = sel.value.keys.some((k) => !before.has(k)) || sel.value.names.length < c.excludedNames.length;
        const changed = added || sel.value.keys.length !== c.includeKeys.length || sel.value.names.length !== c.excludedNames.length;
        const at = clock.now().toISOString();
        const next: SourceConfig = {
          ...c,
          includeKeys: sel.value.keys,
          excludedNames: sel.value.names,
          history: changed ? withEvent(c, { at, kind: 'selection_changed', includedItems: sel.value.keys.length }) : c.history,
        };
        if (changed && !(await persist(state, next))) return UNAVAILABLE<ActionResult>();
        return okResult({ source: detail(next), effects: effects(!changed ? 'unchanged' : added ? 'widened' : 'narrowed') });
      });
    },

    async readNow(p, sourceId) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const first = await loadState();
      if (first === undefined) return UNAVAILABLE();
      const config = own(first, p, sourceId);
      if (config === undefined) return NOT_FOUND();
      // Backend enforcement: a stopped source is never read, whatever the caller (UI or API) asks.
      if (config.disconnected) return failResult('conflict', 'this source is disconnected; reconnect it before reading');
      const key = configKey(p.id, sourceId);
      if (reading.has(key)) return failResult('conflict', 'a read of this source is already running');
      reading.add(key);
      try {
        const names = new Set(config.excludedNames);
        const listing = await backend.list(p, { root: config.root, excludedNames: config.excludedNames });
        let report: ReadReport;
        if (!listing.ok) {
          report = {
            requested: config.includeKeys.length,
            read: 0,
            unreadable: config.includeKeys.length,
            skipped: { notIncluded: 0, notAcquirable: 0, vanished: 0 },
            status: 'failed',
            errorCodes: [listing.error.code],
            evidence: 'not_retained',
            retired: 0,
          };
        } else {
          const byKey = new Map(listing.value.entries.map((e) => [e.key, e] as const));
          let vanished = 0;
          let notAcquirable = 0;
          let notIncluded = 0;
          const toRead: string[] = [];
          for (const k of config.includeKeys) {
            const e = byKey.get(k);
            if (e === undefined) vanished += 1;
            else if (excludedByName(k, names)) notIncluded += 1;
            else if (!e.contentAcquirable) notAcquirable += 1;
            else toRead.push(k);
          }
          const errorCodes: string[] = listing.value.truncated ? ['listing_truncated'] : [];
          let itemsRead = 0;
          let partial = listing.value.truncated;
          let retired = 0;
          let retained = false;
          let assertionsAdded: number | undefined;
          let notUnderstood: number | undefined;
          if (backend.ingest !== undefined) {
            // Durable path. Every chosen, non-excluded item goes in scope, INCLUDING ones that have vanished: the backend learns an item
            // was deleted only by being told it is still chosen. Items excluded by name stay out of scope, so excluding never retires.
            const scoped = config.includeKeys.filter((k) => !excludedByName(k, names));
            if (scoped.length > backend.maxItemsPerRead) {
              errorCodes.push('too_many_items_for_retained_evidence');
              partial = true;
            } else if (toRead.length > 0 || scoped.length > 0) {
              const out = await backend.ingest(p, {
                sourceId,
                root: config.root,
                excludedNames: config.excludedNames,
                keys: scoped,
                presentKeys: toRead,
                epoch: config.epoch ?? 0,
              });
              if (!out.ok) {
                errorCodes.push(out.error.code);
                partial = true;
              } else {
                retained = true;
                retired = out.value.itemsRetired;
                assertionsAdded = out.value.assertionsAdded;
                notUnderstood = out.value.notUnderstood;
                // A complete ingestion means every chosen item that is present is retained (new, changed or already held).
                itemsRead = out.value.partial ? Math.min(out.value.itemsIngested, toRead.length) : toRead.length;
                if (out.value.partial) partial = true;
                for (const code of out.value.errorCodes) if (!errorCodes.includes(code)) errorCodes.push(code);
              }
            }
          } else {
            for (let i = 0; i < toRead.length; i += backend.maxItemsPerRead) {
              const chunk = toRead.slice(i, i + backend.maxItemsPerRead);
              const out = await backend.read(p, { sourceId, root: config.root, excludedNames: config.excludedNames, keys: chunk });
              if (!out.ok) {
                errorCodes.push(out.error.code);
                partial = true;
                break;
              }
              itemsRead += Math.min(out.value.itemsRead, chunk.length);
              if (out.value.partial) partial = true;
              for (const code of out.value.errorCodes) if (!errorCodes.includes(code)) errorCodes.push(code);
            }
          }
          const unreadable = toRead.length - itemsRead;
          const status: ReadReport['status'] =
            toRead.length > 0 && itemsRead === 0 ? 'failed' : unreadable > 0 || partial || toRead.length === 0 ? 'partial' : 'complete';
          report = {
            requested: config.includeKeys.length,
            read: itemsRead,
            unreadable,
            skipped: { notIncluded, notAcquirable, vanished },
            status,
            errorCodes,
            evidence: retained ? 'retained' : 'not_retained',
            retired,
            ...(assertionsAdded !== undefined ? { assertionsAdded } : {}),
            ...(notUnderstood !== undefined ? { notUnderstood } : {}),
          };
        }
        return await serial(async () => {
          const state = await loadState();
          if (state === undefined) return UNAVAILABLE<ActionResult>();
          const c = own(state, p, sourceId);
          if (c === undefined) return NOT_FOUND<ActionResult>();
          const at = clock.now().toISOString();
          const next: SourceConfig = {
            ...c,
            ...(report.read > 0 ? { lastReadAt: at } : {}),
            history: withEvent(c, { at, kind: 'read', read: report }),
          };
          if (!(await persist(state, next))) return UNAVAILABLE<ActionResult>();
          return okResult({ source: detail(next), effects: effects('unchanged') });
        });
      } finally {
        reading.delete(key);
      }
    },

    async checkSource(p, sourceId) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const state = await loadState();
      if (state === undefined) return UNAVAILABLE();
      const c = own(state, p, sourceId);
      if (c === undefined) return NOT_FOUND();
      if (c.disconnected) return failResult('conflict', 'this source is disconnected; reconnect it before checking');
      const listing = await backend.list(p, { root: c.root, excludedNames: c.excludedNames });
      if (!listing.ok) return listing;
      const fresh = await loadState();
      const now = fresh === undefined ? undefined : own(fresh, p, sourceId);
      return now === undefined ? NOT_FOUND() : okResult({ source: detail(now), effects: effects('unchanged') });
    },

    async previewRemoval(p, sourceId) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const state = await loadState();
      if (state === undefined) return UNAVAILABLE();
      const c = own(state, p, sourceId);
      if (c === undefined) return NOT_FOUND();
      return okResult({ evidenceItems: backend.evidenceCount?.(sourceId) ?? 0, factDependencies: 'not_available' });
    },

    async removeSource(p, sourceId) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const first = await loadState();
      if (first === undefined) return UNAVAILABLE();
      if (own(first, p, sourceId) === undefined) return NOT_FOUND();
      const key = configKey(p.id, sourceId);
      if (reading.has(key)) return failResult('conflict', 'a read of this source is running; try again when it finishes');
      reading.add(key);
      try {
        // Evidence first: if retiring it fails the source stays, so the user can retry and nothing is half-forgotten.
        let retired = 0;
        if (backend.removeEvidence !== undefined) {
          const r = await backend.removeEvidence(p, sourceId);
          if (!r.ok) return r;
          retired = r.value.itemsRetired;
        }
        return await serial(async () => {
          const state = await loadState();
          if (state === undefined) return UNAVAILABLE<RemovalResult>();
          if (own(state, p, sourceId) === undefined) return NOT_FOUND<RemovalResult>();
          const rest = { ...state.sources };
          delete rest[key];
          try {
            await store.save({ version: 1, sources: rest });
          } catch {
            return UNAVAILABLE<RemovalResult>();
          }
          return okResult({ removed: true, evidenceItemsRetired: retired, sourceFilesChanged: false });
        });
      } finally {
        reading.delete(key);
      }
    },

    async removeLearned(p, sourceId, request) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      if (request === null || typeof request !== 'object') return failResult('invalid_request', 'the request is not valid');
      const keys = cleanKeys(request.keys);
      if (keys === undefined || keys.length === 0 || keys.length > MAX_REMOVAL_ITEMS)
        return failResult('invalid_request', `name between 1 and ${MAX_REMOVAL_ITEMS} items`);
      if (backend.removeEvidenceItems === undefined)
        return failResult('unavailable', 'this host does not keep what it reads, so there is nothing to remove');
      const first = await loadState();
      if (first === undefined) return UNAVAILABLE();
      if (own(first, p, sourceId) === undefined) return NOT_FOUND();
      const key = configKey(p.id, sourceId);
      if (reading.has(key)) return failResult('conflict', 'a read of this source is running; try again when it finishes');
      reading.add(key);
      try {
        // 1. Stop reading these items (fail-safe direction: a failure after this leaves them unread, never re-learned).
        const stopped = await serial(async () => {
          const state = await loadState();
          if (state === undefined) return UNAVAILABLE<number>();
          const c = own(state, p, sourceId);
          if (c === undefined) return NOT_FOUND<number>();
          const drop = new Set(keys);
          const next: SourceConfig = { ...c, includeKeys: c.includeKeys.filter((k) => !drop.has(k)), epoch: (c.epoch ?? 0) + 1 };
          const unchosen = c.includeKeys.length - next.includeKeys.length;
          const withHistory: SourceConfig =
            unchosen === 0
              ? c
              : {
                  ...next,
                  history: withEvent(c, {
                    at: clock.now().toISOString(),
                    kind: 'selection_changed',
                    includedItems: next.includeKeys.length,
                  }),
                };
          if (unchosen > 0 && !(await persist(state, withHistory))) return UNAVAILABLE<number>();
          return okResult(unchosen);
        });
        if (!stopped.ok) return stopped;
        // 2. Retire what was kept from them.
        const r = await backend.removeEvidenceItems(p, { sourceId, keys });
        if (!r.ok) return r;
        return await serial(async () => {
          const state = await loadState();
          if (state === undefined) return UNAVAILABLE<ItemRemovalResult>();
          const c = own(state, p, sourceId);
          if (c === undefined) return NOT_FOUND<ItemRemovalResult>();
          const next: SourceConfig = {
            ...c,
            history: withEvent(c, { at: clock.now().toISOString(), kind: 'learned_removed', retired: r.value.itemsRetired }),
          };
          if (!(await persist(state, next))) return UNAVAILABLE<ItemRemovalResult>();
          return okResult({
            removed: true,
            evidenceItemsRetired: r.value.itemsRetired,
            itemsNoLongerRead: stopped.value,
            sourceFilesChanged: false,
            source: detail(next),
          });
        });
      } finally {
        reading.delete(key);
      }
    },

    async disconnect(p, sourceId) {
      if (!authed(p)) return unauth();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      return serial(async () => {
        const state = await loadState();
        if (state === undefined) return UNAVAILABLE<ActionResult>();
        const c = own(state, p, sourceId);
        if (c === undefined) return NOT_FOUND<ActionResult>();
        if (c.disconnected) return okResult({ source: detail(c), effects: effects('unchanged') });
        const next: SourceConfig = {
          ...c,
          disconnected: true,
          history: withEvent(c, { at: clock.now().toISOString(), kind: 'disconnected' }),
        };
        if (!(await persist(state, next))) return UNAVAILABLE<ActionResult>();
        return okResult({ source: detail(next), effects: effects('stopped') });
      });
    },

    async reconnect(p, sourceId) {
      if (!authed(p)) return unauth();
      if (!localFolders) return NO_LOCAL();
      {
        const g = await gate(p, 'manageSources');
        if (g) return g;
      }
      const first = await loadState();
      if (first === undefined) return UNAVAILABLE();
      const existing = own(first, p, sourceId);
      if (existing === undefined) return NOT_FOUND();
      if (!existing.disconnected) return okResult({ source: detail(existing), effects: effects('unchanged') });
      // Resuming needs the platform to authorize access again; if it will not, the source stays disconnected.
      const listing = await backend.list(p, { root: existing.root, excludedNames: existing.excludedNames });
      if (!listing.ok) return listing;
      return serial(async () => {
        const state = await loadState();
        if (state === undefined) return UNAVAILABLE<ActionResult>();
        const c = own(state, p, sourceId);
        if (c === undefined) return NOT_FOUND<ActionResult>();
        const next: SourceConfig = {
          ...c,
          disconnected: false,
          history: withEvent(c, { at: clock.now().toISOString(), kind: 'reconnected' }),
        };
        if (!(await persist(state, next))) return UNAVAILABLE<ActionResult>();
        return okResult({ source: detail(next), effects: effects('resumed') });
      });
    },
  };
}

export { EMPTY_STATE };
