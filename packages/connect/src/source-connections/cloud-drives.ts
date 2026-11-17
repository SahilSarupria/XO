/**
 * UW-12a part 2 — reading a folder in a cloud drive: OneDrive and SharePoint (Microsoft Graph) and Google Drive, behind the same
 * `SourceReader` port as local folders. Read-only: nothing here can write, move, share or delete.
 *
 * The HTTP is injected (`DriveHttp`): the host gives authorised requests through the UW-9 credential broker over the pinned egress
 * transport, so the token never reaches this module and every request goes only to the provider's own hosts.
 *
 * The same rules as a local folder decide what is taken (hidden, credential-looking, unsupported and oversize files are counted,
 * never read), shortcuts to other places are never followed, and listings are bounded. Provider facts used here, with sources, are
 * in docs/SOURCE_CONNECTIONS.md.
 */
import {
  DEFAULT_FOLDER_LIMITS,
  FolderError,
  fileSkipReason,
  folderSkipReason,
  type FolderItem,
  type FolderLimits,
  type FolderListing,
  type FolderSkipReason,
  type SourceReader,
} from './folder-reader.js';

export interface DriveHttp {
  /** An authorised GET to the provider's API that answers JSON. */
  getJson(url: string): Promise<unknown>;
  /** An authorised GET to the provider's API that answers bytes. */
  getBytes(url: string, maxBytes: number): Promise<Uint8Array>;
  /** An UNAUTHORISED GET (Microsoft's pre-authenticated download address): the caller must not attach the token. */
  getPublicBytes(url: string, maxBytes: number): Promise<Uint8Array>;
}

export type CloudDriveProvider = 'microsoft' | 'google';

/** Hosts each provider's API and downloads live on. The egress allowlist for a drive connection is exactly this. */
export const DRIVE_API_HOSTS: Readonly<Record<CloudDriveProvider, readonly string[]>> = {
  microsoft: ['graph.microsoft.com'],
  google: ['www.googleapis.com'],
};
/** Where Microsoft's pre-authenticated download addresses point: SharePoint (work and school) and OneDrive personal storage. */
export const MICROSOFT_DOWNLOAD_HOSTS: readonly string[] = ['*.sharepoint.com', '*.files.1drv.com', '*.1drv.com'];

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DRIVE_V3 = 'https://www.googleapis.com/drive/v3';
/** Google's limit on exported Docs and Sheets. */
export const GOOGLE_EXPORT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 200;

const hostMatches = (host: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));

class Lister {
  readonly items: FolderItem[] = [];
  readonly skipped: Partial<Record<FolderSkipReason, number>> = {};
  truncated: FolderListing['truncated'];
  private total = 0;
  constructor(
    private readonly extensions: ReadonlySet<string>,
    readonly limits: FolderLimits,
  ) {}
  skip(r: FolderSkipReason): void {
    this.skipped[r] = (this.skipped[r] ?? 0) + 1;
  }
  enter(name: string, depth: number): boolean {
    const why = folderSkipReason(name, depth, this.limits);
    if (why !== undefined) this.skip(why);
    return why === undefined;
  }
  /** Adds a file if the rules allow it; false once a limit stops the listing. */
  file(
    f: { key: string; name: string; sizeBytes: number; modifiedAt: string; ref: string },
    sizeCeiling = this.limits.maxFileBytes,
  ): boolean {
    const why = fileSkipReason(f.name, f.sizeBytes, this.extensions, { ...this.limits, maxFileBytes: sizeCeiling });
    if (why !== undefined) {
      this.skip(why);
      return true;
    }
    if (this.items.length >= this.limits.maxFiles) {
      this.truncated = 'max_files';
      return false;
    }
    if (this.total + f.sizeBytes > this.limits.maxTotalBytes) {
      this.truncated = 'max_total_bytes';
      return false;
    }
    this.total += f.sizeBytes;
    const dot = f.name.lastIndexOf('.');
    this.items.push({ ...f, extension: dot > 0 ? f.name.slice(dot).toLowerCase() : '' });
    return true;
  }
  done(): FolderListing {
    this.items.sort((a, b) => a.key.localeCompare(b.key));
    return { items: this.items, skipped: this.skipped, ...(this.truncated !== undefined ? { truncated: this.truncated } : {}) };
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0;
/** A provider's own name for a file, made safe as a path segment (a `/` in a name must not invent a folder). */
const segment = (name: string): string => name.replace(/[/\\\u0000]/g, '_');

// ------------------------------------------------------------------------------------------------ Microsoft (OneDrive, SharePoint)

const GRAPH_ID = /^[A-Za-z0-9!_.,:-]{1,256}$/;

export interface MicrosoftDriveLocation {
  /** The drive (a person's OneDrive, or a SharePoint document library). */
  readonly driveId: string;
  /** The folder's item id; `root` for the drive's top. */
  readonly folderId: string;
}

export function microsoftDriveReader(
  at: MicrosoftDriveLocation,
  http: DriveHttp,
  extensions: ReadonlySet<string>,
  limits: FolderLimits = DEFAULT_FOLDER_LIMITS,
): SourceReader {
  if (!GRAPH_ID.test(at.driveId) || !GRAPH_ID.test(at.folderId)) throw new FolderError('root_invalid', 'that is not a drive and folder id');
  const items = (id: string) => `${GRAPH}/drives/${encodeURIComponent(at.driveId)}/items/${encodeURIComponent(id)}`;
  return {
    async list() {
      const l = new Lister(extensions, limits);
      const queue: { id: string; prefix: string; depth: number }[] = [{ id: at.folderId, prefix: '', depth: 0 }];
      let pages = 0;
      while (queue.length > 0 && l.truncated === undefined) {
        const dir = queue.shift()!;
        let url: string | undefined =
          `${items(dir.id)}/children?$select=id,name,size,file,folder,package,remoteItem,lastModifiedDateTime&$top=200`;
        while (url !== undefined && l.truncated === undefined) {
          if (++pages > MAX_PAGES) {
            l.truncated = 'max_files';
            break;
          }
          const page = obj(await http.getJson(url));
          for (const raw of Array.isArray(page['value']) ? page['value'] : []) {
            const it = obj(raw);
            const id = str(it['id']);
            const name = str(it['name']);
            if (id === undefined || name === undefined || !GRAPH_ID.test(id)) continue;
            const key = `${dir.prefix}${segment(name)}`;
            if (it['remoteItem'] !== undefined) l.skip('shortcut_not_followed');
            else if (it['folder'] !== undefined) {
              if (l.enter(name, dir.depth + 1)) queue.push({ id, prefix: `${key}/`, depth: dir.depth + 1 });
            } else if (it['package'] !== undefined) l.skip('unsupported_format');
            else if (it['file'] !== undefined) {
              if (
                !l.file({
                  key,
                  name: segment(name),
                  sizeBytes: num(it['size']),
                  modifiedAt: str(it['lastModifiedDateTime']) ?? '',
                  ref: id,
                })
              )
                break;
            } else l.skip('not_regular_file');
          }
          const next = str(page['@odata.nextLink']);
          // A next page is followed only on Graph itself.
          url = next !== undefined && next.startsWith(`${GRAPH}/`) ? next : undefined;
        }
      }
      return l.done();
    },
    async read(item) {
      if (item.ref === undefined || !GRAPH_ID.test(item.ref)) throw new FolderError('item_missing', `${item.name} has no drive id`);
      const meta = obj(await http.getJson(`${items(item.ref)}?$select=id,size,file,@microsoft.graph.downloadUrl`));
      if (meta['file'] === undefined) throw new FolderError('item_changed', `${item.name} is no longer a file`);
      if (num(meta['size']) > limits.maxFileBytes) throw new FolderError('item_changed', `${item.name} grew past the size limit`);
      const download = str(meta['@microsoft.graph.downloadUrl']);
      let u: URL;
      try {
        u = new URL(download ?? '');
      } catch {
        throw new FolderError('remote_unavailable', `${item.name}: Microsoft gave no download address`);
      }
      if (u.protocol !== 'https:' || !hostMatches(u.hostname.toLowerCase(), MICROSOFT_DOWNLOAD_HOSTS))
        throw new FolderError('remote_unavailable', `${item.name}: the download address is not on a Microsoft storage host`);
      return http.getPublicBytes(u.toString(), limits.maxFileBytes);
    },
  };
}

// ------------------------------------------------------------------------------------------------ Google Drive

const GOOGLE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
/** Native Google files XO can read, exported to the format it reads them as. */
const EXPORTS: Readonly<Record<string, { readonly mime: string; readonly extension: string }>> = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
};

export interface GoogleDriveLocation {
  /** The folder's id; `root` for My Drive. */
  readonly folderId: string;
}

export function googleDriveReader(
  at: GoogleDriveLocation,
  http: DriveHttp,
  extensions: ReadonlySet<string>,
  limits: FolderLimits = DEFAULT_FOLDER_LIMITS,
): SourceReader {
  if (!GOOGLE_ID.test(at.folderId)) throw new FolderError('root_invalid', 'that is not a folder id');
  return {
    async list() {
      const l = new Lister(extensions, limits);
      const queue: { id: string; prefix: string; depth: number }[] = [{ id: at.folderId, prefix: '', depth: 0 }];
      let pages = 0;
      while (queue.length > 0 && l.truncated === undefined) {
        const dir = queue.shift()!;
        let pageToken: string | undefined;
        do {
          if (++pages > MAX_PAGES) {
            l.truncated = 'max_files';
            break;
          }
          // The id is checked against GOOGLE_ID, so it cannot close the quoted string in the query.
          const q = `'${dir.id}' in parents and trashed = false`;
          const url =
            `${DRIVE_V3}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime)')}` +
            `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const page = obj(await http.getJson(url));
          let stop = false;
          for (const raw of Array.isArray(page['files']) ? page['files'] : []) {
            const f = obj(raw);
            const id = str(f['id']);
            const name = str(f['name']);
            const mime = str(f['mimeType']) ?? '';
            if (id === undefined || name === undefined || !GOOGLE_ID.test(id)) continue;
            const safe = segment(name);
            if (mime === FOLDER_MIME) {
              if (l.enter(name, dir.depth + 1)) queue.push({ id, prefix: `${dir.prefix}${safe}/`, depth: dir.depth + 1 });
            } else if (mime === SHORTCUT_MIME) l.skip('shortcut_not_followed');
            else if (mime.startsWith('application/vnd.google-apps.')) {
              const ex = EXPORTS[mime];
              if (ex === undefined) l.skip('native_not_exportable');
              else {
                const asName = safe.toLowerCase().endsWith(ex.extension) ? safe : `${safe}${ex.extension}`;
                // Native files have no stored size; Google exports at most 10 MB.
                stop = !l.file(
                  {
                    key: `${dir.prefix}${asName}`,
                    name: asName,
                    sizeBytes: 0,
                    modifiedAt: str(f['modifiedTime']) ?? '',
                    ref: `export:${id}:${mime}`,
                  },
                  Math.min(limits.maxFileBytes, GOOGLE_EXPORT_MAX_BYTES),
                );
              }
            } else
              stop = !l.file({
                key: `${dir.prefix}${safe}`,
                name: safe,
                sizeBytes: num(f['size']),
                modifiedAt: str(f['modifiedTime']) ?? '',
                ref: `media:${id}`,
              });
            if (stop) break;
          }
          if (stop) break;
          pageToken = str(page['nextPageToken']);
        } while (pageToken !== undefined && l.truncated === undefined);
      }
      return l.done();
    },
    async read(item) {
      const m = /^(media|export):([A-Za-z0-9_-]{1,200})(?::(.+))?$/.exec(item.ref ?? '');
      if (m === null) throw new FolderError('item_missing', `${item.name} has no drive id`);
      const id = m[2]!;
      if (m[1] === 'media') return http.getBytes(`${DRIVE_V3}/files/${id}?alt=media&supportsAllDrives=true`, limits.maxFileBytes);
      const ex = EXPORTS[m[3] ?? ''];
      if (ex === undefined) throw new FolderError('item_missing', `${item.name} cannot be exported`);
      return http.getBytes(
        `${DRIVE_V3}/files/${id}/export?mimeType=${encodeURIComponent(ex.mime)}`,
        Math.min(limits.maxFileBytes, GOOGLE_EXPORT_MAX_BYTES),
      );
    },
  };
}

// ------------------------------------------------------------------------------------------------ choosing a folder

export interface DriveFolderChoice {
  /** For `microsoft`: `<driveId>:<folderId>`; for `google`: the folder id. Pass it back as the connection's `folder`. */
  readonly ref: string;
  readonly name: string;
  readonly kind: 'drive' | 'folder';
}

/**
 * The folders a person can pick from: with no `parent`, their drives (Microsoft: their OneDrive and the SharePoint libraries they
 * follow are reached by drive id; Google: My Drive and shared drives); with a parent, its subfolders. Folders only, never files.
 */
export async function listDriveFolders(provider: CloudDriveProvider, http: DriveHttp, parent?: string): Promise<DriveFolderChoice[]> {
  const out: DriveFolderChoice[] = [];
  if (provider === 'microsoft') {
    if (parent === undefined) {
      const me = obj(await http.getJson(`${GRAPH}/me/drive?$select=id,name`));
      const id = str(me['id']);
      if (id !== undefined && GRAPH_ID.test(id)) out.push({ ref: `${id}:root`, name: str(me['name']) ?? 'OneDrive', kind: 'drive' });
      return out;
    }
    const [driveId, folderId] = parent.split(':');
    if (driveId === undefined || folderId === undefined || !GRAPH_ID.test(driveId) || !GRAPH_ID.test(folderId))
      throw new FolderError('root_invalid', 'that is not a drive and folder id');
    const page = obj(
      await http.getJson(
        `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$select=id,name,folder&$top=200`,
      ),
    );
    for (const raw of Array.isArray(page['value']) ? page['value'] : []) {
      const it = obj(raw);
      const id = str(it['id']);
      if (it['folder'] !== undefined && id !== undefined && GRAPH_ID.test(id))
        out.push({ ref: `${driveId}:${id}`, name: str(it['name']) ?? id, kind: 'folder' });
    }
    return out;
  }
  if (parent === undefined) {
    out.push({ ref: 'root', name: 'My Drive', kind: 'drive' });
    const drives = obj(await http.getJson(`${DRIVE_V3}/drives?pageSize=100&fields=${encodeURIComponent('drives(id,name)')}`));
    for (const raw of Array.isArray(drives['drives']) ? drives['drives'] : []) {
      const d = obj(raw);
      const id = str(d['id']);
      if (id !== undefined && GOOGLE_ID.test(id)) out.push({ ref: id, name: str(d['name']) ?? id, kind: 'drive' });
    }
    return out;
  }
  if (!GOOGLE_ID.test(parent)) throw new FolderError('root_invalid', 'that is not a folder id');
  const q = `'${parent}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`;
  const page = obj(
    await http.getJson(
      `${DRIVE_V3}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    ),
  );
  for (const raw of Array.isArray(page['files']) ? page['files'] : []) {
    const f = obj(raw);
    const id = str(f['id']);
    if (id !== undefined && GOOGLE_ID.test(id)) out.push({ ref: id, name: str(f['name']) ?? id, kind: 'folder' });
  }
  return out;
}

/** The folder's display name, for the connection (`root` reads as the drive). */
export async function driveFolderName(provider: CloudDriveProvider, http: DriveHttp, ref: string): Promise<string> {
  if (provider === 'microsoft') {
    const [driveId, folderId] = ref.split(':');
    if (driveId === undefined || folderId === undefined || !GRAPH_ID.test(driveId) || !GRAPH_ID.test(folderId))
      throw new FolderError('root_invalid', 'that is not a drive and folder id');
    const it = obj(
      await http.getJson(
        `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}?$select=id,name,folder,root`,
      ),
    );
    if (it['folder'] === undefined && it['root'] === undefined) throw new FolderError('root_invalid', 'that item is not a folder');
    return str(it['name']) ?? 'OneDrive';
  }
  if (!GOOGLE_ID.test(ref)) throw new FolderError('root_invalid', 'that is not a folder id');
  if (ref === 'root') return 'My Drive';
  const f = obj(await http.getJson(`${DRIVE_V3}/files/${ref}?fields=${encodeURIComponent('id,name,mimeType')}&supportsAllDrives=true`));
  if (str(f['mimeType']) !== FOLDER_MIME && str(f['mimeType']) !== undefined)
    throw new FolderError('root_invalid', 'that item is not a folder');
  return str(f['name']) ?? ref;
}
