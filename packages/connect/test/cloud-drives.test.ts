// UW-12a part 2: reading OneDrive/SharePoint and Google Drive folders through the reader port, over a fake provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOLDER_LIMITS,
  FolderError,
  googleDriveReader,
  listDriveFolders,
  microsoftDriveReader,
  type DriveHttp,
} from '../src/index.js';

const EXT = new Set(['.pdf', '.xlsx', '.csv', '.docx']);

function fake(routes: Record<string, unknown>, bytes: Record<string, string> = {}) {
  const calls: { url: string; auth: boolean }[] = [];
  const http: DriveHttp = {
    async getJson(url) {
      calls.push({ url, auth: true });
      if (url.includes('pageToken=tok2')) return { files: [] };
      // The longest matching prefix wins, so a next page is not read as its first page.
      const hit = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.startsWith(k));
      if (hit === undefined) throw new FolderError('item_missing', `no route for ${url}`);
      return routes[hit];
    },
    async getBytes(url) {
      calls.push({ url, auth: true });
      const hit = Object.keys(bytes).find((k) => url.startsWith(k));
      if (hit === undefined) throw new FolderError('item_missing', `no bytes for ${url}`);
      return new TextEncoder().encode(bytes[hit]);
    },
    async getPublicBytes(url) {
      calls.push({ url, auth: false });
      const hit = Object.keys(bytes).find((k) => url.startsWith(k));
      if (hit === undefined) throw new FolderError('item_missing', `no bytes for ${url}`);
      return new TextEncoder().encode(bytes[hit]);
    },
  };
  return { http, calls };
}

const G = 'https://graph.microsoft.com/v1.0/drives/b!drive/items';

test('Microsoft: folders are walked and paged on Graph only; shortcuts, OneNote, hidden and secret files are counted, never read', async () => {
  const { http, calls } = fake(
    {
      [`${G}/F1/children`]: {
        value: [
          { id: 'A', name: 'clients.xlsx', size: 10, file: {}, lastModifiedDateTime: '2026-11-16T10:00:00Z' },
          { id: 'B', name: 'Certificates', folder: { childCount: 2 } },
          { id: 'C', name: 'Shared with me', remoteItem: { id: 'X' } },
          { id: 'D', name: 'Notes', package: { type: 'oneNote' } },
          { id: 'E', name: '.secret.pdf', size: 1, file: {} },
          { id: 'F2', name: 'credentials.csv', size: 1, file: {} },
        ],
        '@odata.nextLink': `${G}/F1/children?$skiptoken=p2`,
      },
      [`${G}/F1/children?$skiptoken=p2`]: {
        value: [{ id: 'G', name: 'notes.txt', size: 1, file: {} }],
        '@odata.nextLink': 'https://evil.example/next',
      },
      [`${G}/B/children`]: { value: [{ id: 'H', name: 'Asha/Rao.pdf', size: 5, file: {}, lastModifiedDateTime: '2026-11-16T10:00:00Z' }] },
      [`${G}/A?`]: {
        id: 'A',
        size: 10,
        file: {},
        '@microsoft.graph.downloadUrl': 'https://acme-my.sharepoint.com/download.aspx?tempauth=t',
      },
      [`${G}/H?`]: { id: 'H', size: 5, file: {}, '@microsoft.graph.downloadUrl': 'https://evil.example/steal' },
    },
    { 'https://acme-my.sharepoint.com/download.aspx': 'workbook bytes' },
  );
  const r = microsoftDriveReader({ driveId: 'b!drive', folderId: 'F1' }, http, EXT);
  const l = await r.list();
  assert.deepEqual(
    l.items.map((i) => i.key),
    ['Certificates/Asha_Rao.pdf', 'clients.xlsx'],
    'a "/" in a provider name cannot invent a folder',
  );
  assert.equal(l.skipped.shortcut_not_followed, 1);
  assert.equal(l.skipped.unsupported_format, 2, 'OneNote and notes.txt');
  assert.equal(l.skipped.hidden, 1);
  assert.equal(l.skipped.sensitive_name, 1);
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'a next page off Graph is not followed');
  const bytes = await r.read(l.items.find((i) => i.key === 'clients.xlsx')!);
  assert.equal(new TextDecoder().decode(bytes), 'workbook bytes');
  assert.equal(calls.at(-1)?.auth, false, 'the pre-authenticated download is fetched without the token');
  await assert.rejects(r.read(l.items[0]!), (e: unknown) => e instanceof FolderError && e.code === 'remote_unavailable');
  assert.throws(() => microsoftDriveReader({ driveId: '../x', folderId: 'F1' }, http, EXT), FolderError);
});

const D = 'https://www.googleapis.com/drive/v3/files';
const q = (id: string) => `${D}?q=${encodeURIComponent(`'${id}' in parents and trashed = false`)}`;

test('Google: folders are walked and paged; Docs and Sheets are exported; shortcuts and Slides are counted; ids cannot break the query', async () => {
  const { http, calls } = fake(
    {
      [`${q('root1')}`]: {
        files: [
          { id: 'f1', name: 'Clients', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-16T10:00:00Z' },
          { id: 'f2', name: 'Certificates', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'f3', name: 'Elsewhere', mimeType: 'application/vnd.google-apps.shortcut' },
          { id: 'f4', name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' },
        ],
        nextPageToken: 'tok2',
      },
      [`${q('f2')}`]: {
        files: [
          { id: 'f5', name: 'asha rao.pdf', mimeType: 'application/pdf', size: '42', modifiedTime: '2026-11-16T10:00:00Z' },
          { id: 'f6', name: 'Letter', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-16T10:00:00Z' },
        ],
      },
    },
    {
      [`${D}/f1/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`]: 'xlsx',
      [`${D}/f5?alt=media`]: 'pdf',
    },
  );
  const r = googleDriveReader({ folderId: 'root1' }, http, EXT);
  const l = await r.list();
  assert.deepEqual(
    l.items.map((i) => i.key),
    ['Certificates/asha rao.pdf', 'Certificates/Letter.docx', 'Clients.xlsx'],
  );
  assert.equal(l.skipped.shortcut_not_followed, 1);
  assert.equal(l.skipped.native_not_exportable, 1);
  assert.ok(
    calls.some((c) => c.url.includes('pageToken=tok2')),
    'the next page is fetched',
  );
  assert.equal(new TextDecoder().decode(await r.read(l.items.find((i) => i.key === 'Clients.xlsx')!)), 'xlsx');
  assert.equal(new TextDecoder().decode(await r.read(l.items.find((i) => i.key.endsWith('.pdf'))!)), 'pdf');
  assert.ok(
    calls.every((c) => c.auth),
    'Google downloads go to the API with the token',
  );
  assert.throws(() => googleDriveReader({ folderId: "x' or name contains 'y" }, http, EXT), FolderError);
});

test('limits stop a drive listing and say so; folder choices are folders only', async () => {
  const many = { value: Array.from({ length: 5 }, (_, i) => ({ id: `I${i}`, name: `f${i}.pdf`, size: 1, file: {} })) };
  const { http } = fake({ [`${G}/F1/children`]: many });
  const l = await microsoftDriveReader({ driveId: 'b!drive', folderId: 'F1' }, http, EXT, { ...DEFAULT_FOLDER_LIMITS, maxFiles: 3 }).list();
  assert.equal(l.items.length, 3);
  assert.equal(l.truncated, 'max_files');

  const g = fake({
    'https://www.googleapis.com/drive/v3/drives': { drives: [{ id: 'sd1', name: 'Team' }] },
    [`${D}?q=${encodeURIComponent(`'sd1' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`)}`]: {
      files: [{ id: 'c1', name: 'Clients' }],
    },
  });
  assert.deepEqual(await listDriveFolders('google', g.http), [
    { ref: 'root', name: 'My Drive', kind: 'drive' },
    { ref: 'sd1', name: 'Team', kind: 'drive' },
  ]);
  assert.deepEqual(await listDriveFolders('google', g.http, 'sd1'), [{ ref: 'c1', name: 'Clients', kind: 'folder' }]);
});
