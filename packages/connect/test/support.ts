import { createHash } from 'node:crypto';
import { establishAuthenticatedPrincipal, type AuthenticatedPrincipal } from '@xo/permissions';
import { failResult, okResult, type ConnectResult, type FolderEntry } from '../src/contract.js';
import type {
  ConnectState,
  ConnectStateStore,
  ListRequest,
  Listing,
  LocalFolderBackend,
  ReadOutcome,
  ReadRequest,
  SourceFacts,
} from '../src/ports.js';

export const principal = (id: string): AuthenticatedPrincipal => {
  const m = establishAuthenticatedPrincipal({ kind: 'human', id });
  if (!m.ok) throw new Error('principal');
  return m.value;
};

export const entry = (key: string, acquirable = true): FolderEntry => ({
  key,
  name: key.split('/').pop() as string,
  extension: '.txt',
  sizeBytes: 10,
  modifiedAt: '2026-11-01T00:00:00.000Z',
  depth: key.split('/').length - 1,
  contentAcquirable: acquirable,
});

export class FakeBackend implements LocalFolderBackend {
  maxItemsPerRead = 2;
  entries: FolderEntry[] = [];
  listDenied = false;
  readFails = false;
  readLog: string[][] = [];
  listCalls = 0;
  factsValue: SourceFacts | undefined = {
    authorization: 'granted',
    connection: 'validated',
    acquisition: 'not_attempted',
    unavailable: false,
  };
  async list(_p: AuthenticatedPrincipal, r: ListRequest): Promise<ConnectResult<Listing>> {
    this.listCalls += 1;
    if (this.listDenied) return failResult('denied', 'denied');
    const names = new Set(r.excludedNames);
    return okResult({
      sourceId: 'src-' + createHash('sha256').update(r.root).digest('hex').slice(0, 16),
      entries: this.entries.filter((e) => !e.key.split('/').some((s) => names.has(s))),
      truncated: false,
      totalBytes: this.entries.length * 10,
      skippedByReason: {},
      limitsHit: [],
    });
  }
  async read(_p: AuthenticatedPrincipal, r: ReadRequest): Promise<ConnectResult<ReadOutcome>> {
    this.readLog.push([...r.keys]);
    if (this.readFails) return failResult('unavailable', 'x', true);
    return okResult({ itemsRead: r.keys.length, partial: false, errorCodes: [] });
  }
  facts(): SourceFacts | undefined {
    return this.factsValue;
  }
}

export class FlakyStore implements ConnectStateStore {
  failSave = false;
  failLoad = false;
  constructor(private readonly inner: ConnectStateStore) {}
  async load(): Promise<ConnectState> {
    if (this.failLoad) throw new Error('x');
    return this.inner.load();
  }
  async save(s: ConnectState): Promise<void> {
    if (this.failSave) throw new Error('x');
    return this.inner.save(s);
  }
}
