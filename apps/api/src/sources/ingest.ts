/**
 * The one place a source is stored: upload, link import, email attachments (routes/source-routes.ts) and UW-12a source connections
 * (source-connections/sync.ts) all come through here, so every file gets the same checks at the door, the same ingest-time
 * measurements and the same audit entry, however it arrived.
 */
import { createHash } from 'node:crypto';
import { MimeError, parseEmail, tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import { ErrorCode, XoError } from '@xo/errors';
import { classifySourceContent, MEDIA_TYPE_BY_FORMAT } from '@xo/pre-execution';
import type { AuditEventInput } from '../audit/audit-entry.js';
import { workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { DocxError, extractDocxText } from './docx-text.js';
import { planEmailAttachments } from './email-attachments.js';
import { FsSourceStore, newSourceId } from './fs-source-store.js';
import { inferMediaType, type EmailAttachmentRecord, type SourceRecord } from './source.js';

export interface StoreContext {
  readonly workspace: WorkspaceRecord;
  readonly dataConfig: WorkspaceDataConfig;
  /** Who the source is recorded against (the uploader; for a connection, the person who connected it). */
  readonly identityId: string;
  /** Writes the workspace audit entry (the actor is decided by the caller). */
  readonly audit: (entry: Omit<AuditEventInput, 'actor'>) => Promise<void>;
}

/** Host + path only: a query string or fragment on a pasted link can carry tokens, so it is never stored or logged. */
export function safeOriginLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

/**
 * The one place a source is persisted — shared by upload and URL import so both get the same checks, the same
 * ingest-time measurements and the same audit entry. `.docx` is parsed here once so a corrupt file is refused at the
 * door (400) instead of failing later inside a compile.
 */
export async function storeSourceBytes(
  ctx: StoreContext,
  filename: string,
  extension: string,
  mediaType: string,
  bytes: Uint8Array,
  origin: NonNullable<SourceRecord['origin']>,
  /** UW-3: how many emails deep this file sits (0 = uploaded or imported directly). */
  emailDepth = 0,
): Promise<SourceRecord> {
  // PX-1 (ADR 0029 decision 3): what the bytes are is decided from the bytes. Content that contradicts the extension, an
  // empty body or an unsupported type is refused with a structured code before anything is stored or parsed.
  const content = classifySourceContent(bytes, extension);
  if (!content.ok)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `cannot accept "${filename}": ${content.message}`, {
      context: {
        sourceRejection: content.code,
        ...(content.detected !== undefined ? { detected: content.detected } : {}),
        ...(content.expected !== undefined ? { expected: [...content.expected] } : {}),
      },
    });
  // An image is stored under the media type of what it is (a PNG saved as .jpg is image/png).
  const detectedMediaType = MEDIA_TYPE_BY_FORMAT[content.detected];
  if (detectedMediaType !== undefined) mediaType = detectedMediaType;
  let ingestNotes: readonly string[] | undefined;
  let stats: SourceRecord['stats'] | undefined;
  let sourceId: string | undefined;
  let attachments: EmailAttachmentRecord[] | undefined;
  const children: string[] = [];
  if (extension === '.docx') {
    try {
      const extracted = extractDocxText(bytes);
      ingestNotes = extracted.notes;
      stats = extracted.stats;
    } catch (cause) {
      if (cause instanceof DocxError) throw new XoError(ErrorCode.INVALID_ARGUMENT, `cannot read this .docx: ${cause.message}`);
      throw cause;
    }
  } else if (extension === '.csv' || extension === '.xlsx') {
    // UW-3: tabular files are read into record sets here, so a broken or hostile file is refused at the door with the reason, and
    // what the reader could not settle (no header, merged cells, ambiguous dates, ...) is shown to the person who uploaded it.
    const tables = extension === '.csv' ? tabularFromCsv(new TextDecoder().decode(bytes)) : tabularFromXlsx(bytes);
    if (!tables.ok)
      throw new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `cannot read this ${extension}: ${tables.error.message.replace(/^cannot read this (CSV|workbook): /, '')}`,
      );
    const sets = tables.value.recordSets;
    stats = {
      rows: sets.reduce((n, r) => n + r.records.length, 0),
      ...(extension === '.xlsx' ? { sheets: tables.value.sheets.length, tables: sets.length } : {}),
    };
    const notes = [...tables.value.findings, ...sets.flatMap((r) => r.findings)].map((f) =>
      f.ref !== undefined ? `${f.ref}: ${f.message}` : f.message,
    );
    if (notes.length > 0) ingestNotes = notes.length > 20 ? [...notes.slice(0, 20), `and ${notes.length - 20} more`] : notes;
  } else if (extension === '.eml') {
    let email;
    try {
      email = parseEmail(bytes, { withContent: true });
    } catch (cause) {
      if (cause instanceof MimeError) throw new XoError(ErrorCode.INVALID_ARGUMENT, `cannot read this .eml: ${cause.message}`);
      throw cause;
    }
    stats = { words: email.body.split(/\s+/).filter(Boolean).length, attachments: email.attachments.length };
    const notes = [...email.findings];
    // UW-3: every attachment the server can read is opened now, as a source of its own linked back to this email, so a certificate
    // forwarded as an attachment is read and compiled like any upload. The email's id is minted first so each attachment can name it.
    sourceId = newSourceId();
    const emailDigestSha256 = createHash('sha256').update(bytes).digest('hex');
    attachments = [];
    const opened: string[] = [];
    const notOpened: string[] = [];
    const bySha = new Map<string, string>();
    try {
      for (const plan of planEmailAttachments(email.attachments, emailDepth)) {
        const a = plan.attachment;
        const base = {
          part: a.part,
          ...(a.filename !== undefined ? { filename: a.filename } : {}),
          contentType: a.contentType,
          size: a.size,
          sha256: a.sha256,
        };
        if (!plan.open) {
          const same = plan.sameAsPart !== undefined ? bySha.get(a.sha256) : undefined;
          attachments.push({ ...base, ...(same !== undefined ? { sourceId: same } : {}), notOpened: plan.reason });
          if (same === undefined) notOpened.push(`${a.filename ?? `part ${a.part}`} (${plan.reason})`);
          continue;
        }
        try {
          const child = await storeSourceBytes(
            ctx,
            plan.filename,
            plan.extension,
            inferMediaType(plan.extension, undefined),
            a.content!,
            { kind: 'email-attachment', emailSourceId: sourceId, emailDigestSha256, emailFilename: filename, part: a.part },
            emailDepth + 1,
          );
          children.push(child.sourceId);
          bySha.set(a.sha256, child.sourceId);
          attachments.push({ ...base, sourceId: child.sourceId });
          opened.push(plan.filename);
        } catch (cause) {
          // An attachment the door refuses (a corrupt .docx, a broken workbook) is reported on the email; it does not fail the email.
          if (!(cause instanceof XoError) || cause.code !== ErrorCode.INVALID_ARGUMENT) throw cause;
          const reason = cause.message.replace(/^(?:cannot read this [^:]+|cannot accept "[^"]*"): /, 'it could not be read: ');
          attachments.push({ ...base, notOpened: reason });
          notOpened.push(`${plan.filename} (${reason})`);
        }
      }
    } catch (cause) {
      await removeSources(ctx, children);
      throw cause;
    }
    if (opened.length > 0) notes.push(`Opened ${opened.length} attachment(s) as their own sources: ${opened.join(', ')}.`);
    if (notOpened.length > 0) notes.push(`Not opened: ${notOpened.join('; ')}.`);
    if (notes.length > 0) ingestNotes = notes;
  } else if (extension === '.txt' || extension === '.md') {
    stats = { words: new TextDecoder().decode(bytes).split(/\s+/).filter(Boolean).length };
  }
  const { workspace } = ctx;
  const store = new FsSourceStore(workspaceSourcesStore(workspace, ctx.dataConfig));
  const created = await store.create(workspace.workspaceId, ctx.identityId, {
    originalFilename: filename,
    mediaType,
    extension,
    bytes,
    origin,
    ...(ingestNotes !== undefined ? { ingestNotes } : {}),
    ...(stats !== undefined ? { stats } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
  if (!created.ok) {
    await removeSources(ctx, children);
    throw created.error;
  }
  await ctx.audit({
    event:
      origin.kind === 'url'
        ? 'source.imported'
        : origin.kind === 'email-attachment'
          ? 'source.extracted'
          : origin.kind === 'connection'
            ? 'source.synced'
            : 'source.uploaded',
    result: 'succeeded',
    target: { kind: 'source', id: created.value.sourceId, label: filename },
    detail: {
      bytes: bytes.length,
      mediaType,
      ...(origin.kind === 'url' ? { from: safeOriginLabel(origin.url) } : {}),
      ...(origin.kind === 'email-attachment' ? { fromEmail: origin.emailSourceId, part: origin.part } : {}),
      ...(origin.kind === 'connection' ? { fromConnection: origin.connectionId } : {}),
      ...(children.length > 0 ? { attachmentsOpened: children.length } : {}),
    },
  });
  return created.value;
}

/** Best-effort undo of attachment sources stored for an email that then could not be stored itself. */
async function removeSources(ctx: StoreContext, sourceIds: readonly string[]): Promise<void> {
  const store = new FsSourceStore(workspaceSourcesStore(ctx.workspace, ctx.dataConfig));
  for (const id of sourceIds) await store.delete(id).catch(() => undefined);
}
