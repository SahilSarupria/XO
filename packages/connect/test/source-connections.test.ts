// UW-12a: the folder reader behind workspace source connections, and discovery's proposed roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FolderError,
  approveRoot,
  discoveryMessage,
  freshnessOf,
  listFolder,
  proposeRoles,
  proposalViews,
  readFolderItem,
  type DiscoveryItem,
  type SourceConnection,
} from '../src/index.js';

const EXT = new Set(['.pdf', '.xlsx', '.csv', '.txt']);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-scn-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('approveRoot: only inside an allowed root; none configured allows nothing; links cannot widen it', async () => {
  await withDir(async (dir) => {
    const allowed = join(dir, 'allowed');
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(join(allowed, 'clients'), { recursive: true });
    await mkdir(elsewhere);
    await symlink(elsewhere, join(allowed, 'sneaky'));
    assert.equal(await approveRoot(join(allowed, 'clients'), [allowed]), join(allowed, 'clients'));
    await assert.rejects(
      approveRoot(join(allowed, 'clients'), []),
      (e: unknown) => e instanceof FolderError && e.code === 'root_not_allowed',
    );
    await assert.rejects(approveRoot(elsewhere, [allowed]), (e: unknown) => e instanceof FolderError && e.code === 'root_not_allowed');
    // A link inside the allowed root that points outside it is judged by where it really goes.
    await assert.rejects(
      approveRoot(join(allowed, 'sneaky'), [allowed]),
      (e: unknown) => e instanceof FolderError && e.code === 'root_not_allowed',
    );
    await assert.rejects(approveRoot('relative/path', [allowed]), (e: unknown) => e instanceof FolderError && e.code === 'root_invalid');
    await assert.rejects(
      approveRoot(join(allowed, 'missing'), [allowed]),
      (e: unknown) => e instanceof FolderError && e.code === 'root_unavailable',
    );
  });
});

test('listFolder: supported files only; links, hidden, secret-looking, hard-linked and oversize entries are counted, never listed', async () => {
  await withDir(async (root) => {
    await mkdir(join(root, 'Certificates'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'clients.xlsx'), 'x');
    await writeFile(join(root, 'Certificates', 'a.pdf'), 'pdf');
    await writeFile(join(root, 'notes.docx'), 'unsupported here');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await writeFile(join(root, 'credentials.csv'), 'secret');
    await writeFile(join(root, '~$clients.xlsx'), 'lock');
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2000));
    await writeFile(join(root, '.git', 'config.txt'), 'x');
    await writeFile(join(tmpdir(), `xo-outside-${process.pid}.txt`), 'outside');
    await symlink(join(tmpdir(), `xo-outside-${process.pid}.txt`), join(root, 'link.txt'));
    await writeFile(join(root, 'original.txt'), 'hard');
    await link(join(root, 'original.txt'), join(root, 'hardlink.txt'));
    const l = await listFolder(root, EXT, { maxFiles: 100, maxDepth: 4, maxFileBytes: 1000, maxTotalBytes: 1e9 });
    assert.deepEqual(
      l.items.map((i) => i.key),
      ['Certificates/a.pdf', 'clients.xlsx'],
    );
    assert.equal(l.skipped.symlink_not_followed, 1);
    assert.equal(l.skipped.sensitive_name, 1, 'credentials.csv'); // .env is hidden first
    assert.equal(l.skipped.hard_linked_file, 2);
    assert.equal(l.skipped.too_large, 1);
    assert.equal(l.skipped.unsupported_format, 1);
    assert.equal(l.skipped.excluded_directory, 1);
    assert.ok((l.skipped.hidden ?? 0) >= 3);
    await rm(join(tmpdir(), `xo-outside-${process.pid}.txt`));
  });
});

test('listFolder stops at its limits and says so; readFolderItem refuses a file swapped for a link or gone', async () => {
  await withDir(async (root) => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.txt`), `file ${i}`);
    const l = await listFolder(root, EXT, { maxFiles: 3, maxDepth: 4, maxFileBytes: 1000, maxTotalBytes: 1e9 });
    assert.equal(l.items.length, 3);
    assert.equal(l.truncated, 'max_files');
    const item = l.items[0]!;
    assert.equal(new TextDecoder().decode(await readFolderItem(root, item)), 'file 0');
    await rm(join(root, item.key));
    await writeFile(join(tmpdir(), `xo-target-${process.pid}.txt`), 'not yours');
    await symlink(join(tmpdir(), `xo-target-${process.pid}.txt`), join(root, item.key));
    await assert.rejects(readFolderItem(root, item), (e: unknown) => e instanceof FolderError && e.code === 'outside_scope');
    await rm(join(root, item.key));
    await assert.rejects(readFolderItem(root, item), (e: unknown) => e instanceof FolderError && e.code === 'item_missing');
    await assert.rejects(
      readFolderItem(root, { ...item, key: '../etc/passwd' }),
      (e: unknown) => e instanceof FolderError && e.code === 'outside_scope',
    );
    await rm(join(tmpdir(), `xo-target-${process.pid}.txt`));
  });
});

const doc = (key: string): DiscoveryItem => ({
  key,
  name: key.split('/').at(-1)!,
  extension: key.slice(key.lastIndexOf('.')),
  sourceId: `src_${key.length.toString(16).padStart(32, '0')}`,
  digestSha256: key,
});
const CLIENTS: DiscoveryItem = {
  ...doc('clients.xlsx'),
  tables: [
    {
      recordSetId: 'Clients#1',
      sheet: 'Clients',
      rows: 4,
      columns: [
        { header: 'Client name', values: ['Asha Rao', 'Vikram Mehta', 'Zoya Khan', 'Imran Ali'] },
        { header: 'Email', values: ['asha@x.in', 'vikram@x.in', 'zoya@x.in', 'imran@x.in'] },
        { header: 'Policy no', values: ['4471102', '4471108', '4471111', '4471120'] },
      ],
    },
  ],
};

test('discovery: a client list, a folder of certificates, and each client’s certificate — all proposals, with what they rest on', () => {
  const items = [
    CLIENTS,
    doc('Certificates/Asha_Rao_certificate.pdf'),
    doc('Certificates/vikram-mehta-certificate.pdf'),
    doc('Certificates/ZoyaKhan certificate.pdf'),
    doc('Certificates/unknown person certificate.pdf'),
    doc('readme.txt'),
  ];
  const p = proposeRoles(items);
  const list = p.find((x) => x.role === 'contact_list')!;
  assert.equal(list.label, 'a client list');
  assert.equal(list.strength, 'strong');
  assert.ok(list.basis.some((b) => b.includes('"Email" holds email addresses (100% of 4')));
  const folder = p.find((x) => x.role === 'document_collection')!;
  assert.equal(folder.label, 'a folder of certificates');
  assert.equal(folder.counts['documents'], 4);
  const pairing = p.find((x) => x.role === 'per_person_documents')!;
  assert.equal(pairing.label, "each client's certificate");
  assert.deepEqual(pairing.counts, { documents: 4, matched: 3, ambiguous: 0, unmatchedDocuments: 1, peopleWithout: 1 });
  assert.equal(pairing.strength, 'weak', 'one certificate matches no one');
  assert.match(pairing.proposalId, /^rol_[0-9a-f]{16}$/);
  assert.equal(proposeRoles(items).find((x) => x.role === 'per_person_documents')!.proposalId, pairing.proposalId, 'stable across syncs');

  const message = discoveryMessage({
    connections: [{ displayName: 'Renewals', items }],
    proposals: p.map((x) => ({ ...x, status: 'proposed' as const })),
  });
  assert.match(message, /^I found a workbook \(clients\.xlsx\), a folder of certificates \(4\) and 1 other document\./);
  assert.match(message, /clients\.xlsx looks like a client list \(4 rows, each a client\)\. Is that right\?/);
  assert.match(
    message,
    /3 of 4 certificates are named after one client in the client list .*look like each client's certificate\. Is that right\?/,
  );
  assert.match(message, /What would you like to do\?$/);
  assert.ok(!/asha|vikram|zoya|4471/i.test(message), 'the message names files, never a cell value');
});

test('discovery: tables without names and emails are just tables; loose documents are not a collection; nothing found is said plainly', () => {
  const p = proposeRoles([
    {
      ...doc('stock.csv'),
      tables: [
        {
          recordSetId: '#1',
          rows: 3,
          columns: [
            { header: 'SKU', values: ['A1', 'B2', 'C3'] },
            { header: 'Qty', values: ['1', '2', '3'] },
          ],
        },
      ],
    },
    doc('one.pdf'),
  ]);
  assert.deepEqual(
    p.map((x) => x.role),
    ['record_table'],
  );
  assert.equal(
    discoveryMessage({ connections: [{ displayName: 'Empty', items: [] }], proposals: [] }).startsWith(
      'I looked in "Empty" and found nothing',
    ),
    true,
  );
});

test('freshness and decisions: interval connections go stale after two missed slots; a decision on changed files says so', () => {
  const base: SourceConnection = {
    schema: 'xo.source-connection/1',
    connectionId: 'scn_000000000000000000000001',
    workspaceId: 'ws',
    kind: 'local_folder',
    displayName: 'Renewals',
    root: '/x',
    sync: { mode: 'interval', everyMinutes: 60 },
    paused: false,
    createdAt: '2026-11-16T00:00:00.000Z',
    createdBy: 'u',
    revision: 1,
    updatedAt: '2026-11-16T00:00:00.000Z',
    items: [
      {
        key: 'clients.xlsx',
        name: 'clients.xlsx',
        extension: '.xlsx',
        sizeBytes: 1,
        modifiedAt: 'x',
        sourceId: 's',
        digestSha256: 'd1',
        syncedAt: 'x',
      },
    ],
    retired: [],
    lastSync: {
      at: '2026-11-16T10:00:00.000Z',
      outcome: 'complete',
      added: 1,
      changed: 0,
      unchanged: 0,
      removed: 0,
      failed: {},
      skipped: {},
    },
    lastSuccessfulSyncAt: '2026-11-16T10:00:00.000Z',
    proposals: proposeRoles([CLIENTS]),
    decisions: [],
  };
  assert.equal(freshnessOf(base, new Date('2026-11-16T11:30:00Z')).state, 'current');
  assert.equal(freshnessOf(base, new Date('2026-11-16T12:30:00Z')).state, 'stale');
  assert.equal(freshnessOf({ ...base, paused: true }, new Date()).state, 'paused');
  assert.equal(
    freshnessOf({ ...base, lastSync: { ...base.lastSync!, outcome: 'failed', problem: 'gone' } }, new Date()).state,
    'needs_attention',
  );
  const id = base.proposals[0]!.proposalId;
  const decided = { ...base, decisions: [{ proposalId: id, decision: 'confirmed' as const, by: 'u', at: 'x', digests: ['d1'] }] };
  assert.equal(proposalViews(decided)[0]!.changedSinceDecision, false);
  const changed = { ...decided, items: [{ ...base.items[0]!, digestSha256: 'd2' }] };
  assert.equal(proposalViews(changed)[0]!.status, 'confirmed');
  assert.equal(proposalViews(changed)[0]!.changedSinceDecision, true);
});
