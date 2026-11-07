/**
 * A fake of the Connect HTTP contract v1 (packages/connect/docs/HTTP_CONTRACT.md) for Studio tests. It speaks the contract's JSON; it does
 * not pretend to be the platform. Delegates everything else to the supplied fetch.
 */
import type { FakeXo } from './fakeXo';

type Json = Record<string, unknown>;
export interface FakeSource {
  id: string;
  displayName: string;
  state: string;
  selectedKeys: string[];
  history: Json[];
  attention?: { code: string; message: string };
}

const ENTRIES = [
  {
    key: 'a.txt',
    name: 'a.txt',
    extension: '.txt',
    sizeBytes: 100,
    modifiedAt: '2026-11-01T00:00:00.000Z',
    depth: 0,
    contentAcquirable: true,
  },
  {
    key: 'policies/limits.md',
    name: 'limits.md',
    extension: '.md',
    sizeBytes: 200,
    modifiedAt: '2026-11-01T00:00:00.000Z',
    depth: 1,
    contentAcquirable: true,
  },
  {
    key: 'policies/logo.png',
    name: 'logo.png',
    extension: '.png',
    sizeBytes: 300,
    modifiedAt: '2026-11-01T00:00:00.000Z',
    depth: 1,
    contentAcquirable: false,
  },
];

export class FakeConnect {
  sources: FakeSource[] = [];
  manage = true;
  capsStatus = 200;
  malformedCatalog = false;
  localFolders = true;
  calls: Array<{ method: string; path: string; body?: Json }> = [];
  report: Json = {
    requested: 2,
    read: 2,
    unreadable: 0,
    skipped: { notIncluded: 0, notAcquirable: 0, vanished: 0 },
    status: 'complete',
    errorCodes: [],
    evidence: 'retained',
    retired: 0,
    assertionsAdded: 0,
    notUnderstood: 2,
  };

  /** Knowledge the fake returns (C6 KnowledgeResponse shape). */
  statements: Json[] = [];
  knowledgeStatus = 200;
  constructor(private readonly inner: FakeXo) {}

  private kenv = (data: Json): Json => ({
    asOf: '2026-11-04T10:00:00.000Z',
    access: { completeness: 'visible_scope_only', principal: 'redacted' },
    uncertainty: { conflicted: 1, hypotheses: 1, unknown: 0, reviewRequired: 2, singleSource: 1 },
    data,
  });

  private card = (s: FakeSource, detail = false): Json => ({
    id: s.id,
    kind: 'local_folder',
    displayName: s.displayName,
    state: s.state,
    readOnly: true,
    selection: { includedItems: s.selectedKeys.length, excludedNames: 0 },
    dataProvenance: 'live',
    ...(s.attention !== undefined ? { attention: s.attention } : {}),
    ...(detail ? { history: s.history } : {}),
  });
  private effects = (futureReads: string): Json => ({ futureReads, existingKnowledge: 'kept', platformAuthorization: 'unchanged' });
  private preview = (): Json => ({
    entries: ENTRIES,
    truncated: false,
    listingOnly: true,
    summary: { files: 3, acquirableFiles: 2, totalBytes: 600, skippedByReason: {}, limitsHit: [] },
  });

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = input.replace(/^\/api/, '').split('?')[0] as string;
    if (!path.startsWith('/connect/')) return this.inner.fetch(input, init);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const err = (status: number, code: string, message: string) => reply(status, { error: { code, message, retryable: false } });
    const denied = () => err(403, 'denied', 'the principal is not authorized for this operation');
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/connect/knowledge') {
      if (this.knowledgeStatus !== 200) return err(this.knowledgeStatus, 'unavailable', 'knowledge is not available on this host');
      const url = new URL(input, 'http://x');
      const q = url.searchParams.get('q');
      const select = url.searchParams.get('select');
      const rows = this.statements.filter((st) => {
        if (q !== null) return String(st['text']).toLowerCase().includes(q.toLowerCase());
        if (select === 'conflicts') return st['kind'] === 'conflict';
        if (select === 'entities') return st['kind'] === 'entity';
        if (select === 'claims') return st['kind'] === 'claim';
        return true;
      });
      return reply(200, this.kenv({ statements: rows, truncated: false }));
    }
    if (method === 'GET' && path === '/connect/knowledge/review') {
      const items = this.statements
        .filter((st) => st['reviewRequired'] === true)
        .map((st) => ({
          kind: st['kind'] === 'conflict' ? 'conflict' : 'unverified_inference',
          ref: st['ref'],
          summary: st['text'],
          statement: st,
        }));
      return reply(200, this.kenv({ items, truncated: false }));
    }
    if (method === 'GET' && path === '/connect/capabilities')
      return this.capsStatus !== 200
        ? err(this.capsStatus, 'unavailable', 'the authorization gate could not answer')
        : reply(200, { viewSources: true, manageSources: this.manage, readKnowledge: true, reviewKnowledge: false, advisory: true });
    if (method === 'GET' && path === '/connect/catalog') {
      if (this.malformedCatalog) return reply(200, { sources: [{ kind: 'microsoft_365', availability: 'maybe' }] });
      return reply(200, {
        sources: [
          this.localFolders
            ? { kind: 'local_folder', availability: 'available', note: 'Needs the XO desktop connection.' }
            : {
                kind: 'local_folder',
                availability: 'coming_soon',
                note: 'Reading folders on your computer needs the XO desktop connection, which is not available in this deployment yet.',
              },
          {
            kind: 'microsoft_365',
            availability: 'coming_soon',
            note: 'Coming soon. Reading files from Microsoft 365 is not available yet.',
          },
          {
            kind: 'google_workspace',
            availability: 'coming_soon',
            note: 'Coming soon. Reading files from Google Workspace is not available yet.',
          },
        ],
      });
    }
    if (method === 'GET' && path === '/connect/dashboard')
      return reply(200, {
        connectedSources: this.sources.filter((s) => s.state !== 'disconnected').length,
        needsAttention: this.sources.filter((s) => s.state === 'access_expired').length,
        knowledge: {
          availability: 'empty',
          reason: 'No knowledge yet. XO keeps what it reads, but only structured organizational records become knowledge today.',
        },
        dataProvenance: 'live',
      });
    if (method === 'GET' && path === '/connect/sources') return reply(200, { sources: this.sources.map((s) => this.card(s)) });
    if (method === 'POST' && path === '/connect/local-folders/preview') return this.manage ? reply(200, this.preview()) : denied();
    if (method === 'POST' && path === '/connect/local-folders') {
      if (!this.manage) return denied();
      const keys = (body?.['includeKeys'] as string[]) ?? [];
      if (keys.length === 0) return err(400, 'invalid_request', 'nothing is chosen: pick at least one item');
      const s: FakeSource = {
        id: `src_${this.sources.length + 1}`,
        displayName: 'claims',
        state: 'awaiting_first_read',
        selectedKeys: keys,
        history: [{ at: '2026-11-02T00:00:00.000Z', kind: 'connected', includedItems: keys.length }],
      };
      this.sources.push(s);
      return reply(201, { source: this.card(s, true), effects: this.effects('unchanged') });
    }
    if ((m = path.match(/^\/connect\/sources\/([^/]+)(?:\/(.+))?$/)) !== null) {
      const s = this.sources.find((x) => x.id === m![1]);
      if (s === undefined) return err(404, 'not_found', 'that source was not found');
      const action = m[2];
      if (method === 'GET' && action === undefined) return reply(200, this.card(s, true));
      if (method === 'GET' && action === 'folder')
        return reply(200, { preview: this.preview(), selectedKeys: s.selectedKeys, excludedNames: [] });
      if (method === 'GET' && action === 'removal') return reply(200, { evidenceItems: 4, factDependencies: 'not_available' });
      if (!this.manage) return denied();
      if (action === 'read') {
        s.state = 'read_complete';
        s.history.push({ at: '2026-11-02T01:00:00.000Z', kind: 'read', read: this.report });
        return reply(200, { source: this.card(s, true), effects: this.effects('unchanged') });
      }
      if (action === 'disconnect') {
        s.state = 'disconnected';
        s.history.push({ at: '2026-11-02T02:00:00.000Z', kind: 'disconnected' });
        return reply(200, { source: this.card(s, true), effects: this.effects('stopped') });
      }
      if (action === 'reconnect') {
        s.state = 'awaiting_first_read';
        return reply(200, { source: this.card(s, true), effects: this.effects('resumed') });
      }
      if (action === 'check') return reply(200, { source: this.card(s, true), effects: this.effects('unchanged') });
      if (action === 'selection') {
        const before = s.selectedKeys.length;
        s.selectedKeys = (body?.['includeKeys'] as string[]) ?? [];
        return reply(200, { source: this.card(s, true), effects: this.effects(s.selectedKeys.length < before ? 'narrowed' : 'widened') });
      }
      if (action === 'items/remove') {
        const keys = (body?.['keys'] as string[]) ?? [];
        s.selectedKeys = s.selectedKeys.filter((k) => !keys.includes(k));
        s.history.push({ at: '2026-11-02T03:00:00.000Z', kind: 'learned_removed', retired: keys.length });
        return reply(200, {
          removed: true,
          evidenceItemsRetired: keys.length,
          itemsNoLongerRead: keys.length,
          sourceFilesChanged: false,
          source: this.card(s, true),
        });
      }
      if (action === 'remove') {
        this.sources = this.sources.filter((x) => x.id !== s.id);
        return reply(200, { removed: true, evidenceItemsRetired: 4, sourceFilesChanged: false });
      }
    }
    return err(404, 'not_found', 'no such route');
  };
}
