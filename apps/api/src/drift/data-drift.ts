/**
 * UW-15 (ADR 0044) — has the data a compiled workflow reads changed shape? Compares each tabular source the compilation used (as it
 * was compiled: the exact bytes in its source set) with the NEWEST source of the same name in the workspace (next month's workbook).
 * No baseline is stored: the compiled bytes are the baseline. Reports headers, types and value shapes, never cell values.
 */
import { tabularFromCsv, tabularFromXlsx, type TabularSource } from '@xo/compiler';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import {
  detectDrift,
  digestOf,
  fingerprintRecordSet,
  type Digest,
  type DriftDifference,
  type DriftReport,
  type SchemaFingerprint,
} from '@xo/pre-execution';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { workspaceCompilationsStore, workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';

export interface TableDrift {
  readonly recordSetId: string;
  readonly report: DriftReport;
}
export interface SourceDrift {
  readonly sourceName: string;
  readonly compiledSourceId: string;
  readonly incomingSourceId: string;
  readonly tables: readonly TableDrift[];
  readonly status: 'none' | 'warning' | 'blocking';
}
/**
 * UW-15 (ADR 0044 amended): a table a workflow reads that is not the compilation's own source (for example the client list a
 * procedure's steps send to). Recorded on the definition with the schema it had when the workflow was generated; checked at start.
 */
export interface DataRead {
  readonly sourceId: string;
  readonly name: string;
  readonly recordSetId: string;
  readonly fingerprint: SchemaFingerprint;
}

export const MAX_DATA_READS = 20;

export interface DataDriftReport {
  readonly status: 'none' | 'warning' | 'blocking';
  /** Only sources that have a newer same-named version are listed. */
  readonly sources: readonly SourceDrift[];
  readonly checkedSources: number;
}

const parse = (name: string, bytes: Uint8Array): TabularSource | undefined => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) {
    const r = tabularFromCsv(new TextDecoder().decode(bytes));
    return r.ok ? r.value : undefined;
  }
  if (lower.endsWith('.xlsx')) {
    const r = tabularFromXlsx(bytes);
    return r.ok ? r.value : undefined;
  }
  return undefined;
};

/** Validates `reads: [{ sourceId, recordSetId }]` from a request and records each table's schema as it is now. */
export async function resolveDataReads(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
  raw: unknown,
): Promise<readonly DataRead[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_DATA_READS)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `reads must be a list of at most ${MAX_DATA_READS} { sourceId, recordSetId }`);
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  const out: DataRead[] = [];
  for (const item of raw as unknown[]) {
    const r = item as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object' || typeof r['sourceId'] !== 'string' || typeof r['recordSetId'] !== 'string')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'each read is { sourceId, recordSetId }');
    const sourceId = r['sourceId'];
    const recordSetId = r['recordSetId'];
    const meta = await sources.get(sourceId);
    if (!meta.ok) throw new NotFoundError(`source "${sourceId}"`);
    if (meta.value.retired !== undefined)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `source "${sourceId}" is retired; read its current version`);
    const bytes = await sources.getContent(sourceId);
    if (!bytes.ok) throw bytes.error;
    const rs = parse(meta.value.originalFilename, bytes.value)?.recordSets.find((x) => x.id === recordSetId);
    if (rs === undefined)
      throw new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `source "${sourceId}" has no table "${recordSetId}" (only .csv and .xlsx tables can be read)`,
      );
    if (out.some((o) => o.sourceId === sourceId && o.recordSetId === recordSetId)) continue;
    out.push({ sourceId, name: meta.value.originalFilename, recordSetId, fingerprint: fingerprintRecordSet(rs) });
  }
  return out;
}

export async function checkDataDrift(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
  compilationId: string,
  reads: readonly DataRead[] = [],
): Promise<DataDriftReport> {
  const compilations = new FsCompilationStore(workspaceCompilationsStore(workspace, config));
  const artifact = await compilations.getArtifact(compilationId);
  if (!artifact.ok) throw artifact.error;
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  const all = await sources.list();
  if (!all.ok) throw all.error;
  const out: SourceDrift[] = [];
  let checked = 0;
  for (const entry of artifact.value.sourceSet.entries) {
    if (!/\.(csv|xlsx)$/i.test(entry.name)) continue;
    checked++;
    const newest = all.value
      .filter((s) => s.originalFilename === entry.name && s.retired === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sourceId.localeCompare(a.sourceId))[0];
    if (newest === undefined || newest.digestSha256 === entry.digestSha256) continue; // nothing newer: nothing to compare
    const [was, now] = await Promise.all([sources.getContent(entry.sourceId), sources.getContent(newest.sourceId)]);
    if (!was.ok || !now.ok) continue;
    const compiled = parse(entry.name, was.value);
    const incoming = parse(entry.name, now.value);
    if (compiled === undefined) continue;
    const tables: TableDrift[] = compiled.recordSets.map((rs): TableDrift => {
      const fp = fingerprintRecordSet(rs);
      const other = incoming?.recordSets.find((x) => x.id === rs.id);
      if (other === undefined) {
        const d: DriftDifference = {
          kind: 'table_missing',
          severity: 'blocking',
          header: rs.id,
          message: `the table "${rs.id}" is no longer in the new version of ${entry.name}`,
        };
        return {
          recordSetId: rs.id,
          report: {
            status: 'blocking',
            differences: [d],
            checkedColumns: fp.columns.length,
            compiledDigest: fp.digest,
            incomingDigest: fp.digest,
          },
        };
      }
      return { recordSetId: rs.id, report: detectDrift(fp, fingerprintRecordSet(other)) };
    });
    const status = tables.some((t) => t.report.status === 'blocking')
      ? 'blocking'
      : tables.some((t) => t.report.status === 'warning')
        ? 'warning'
        : 'none';
    out.push({ sourceName: entry.name, compiledSourceId: entry.sourceId, incomingSourceId: newest.sourceId, tables, status });
  }
  // UW-15: the tables the workflow reads besides its compilation's own sources, against the schema recorded when it was generated.
  for (const read of reads) {
    if (artifact.value.sourceSet.entries.some((e) => e.sourceId === read.sourceId)) continue; // already checked above
    checked++;
    const newest = all.value
      .filter((s) => s.originalFilename === read.name && s.retired === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sourceId.localeCompare(a.sourceId))[0];
    if (newest?.sourceId === read.sourceId) continue; // unchanged
    let report: DriftReport;
    if (newest === undefined) {
      const d: DriftDifference = {
        kind: 'table_missing',
        severity: 'blocking',
        header: read.recordSetId,
        message: `${read.name} is no longer in the workspace`,
      };
      report = {
        status: 'blocking',
        differences: [d],
        checkedColumns: read.fingerprint.columns.length,
        compiledDigest: read.fingerprint.digest,
        incomingDigest: read.fingerprint.digest,
      };
    } else {
      const now = await sources.getContent(newest.sourceId);
      const other = now.ok ? parse(read.name, now.value)?.recordSets.find((x) => x.id === read.recordSetId) : undefined;
      if (other === undefined) {
        const d: DriftDifference = {
          kind: 'table_missing',
          severity: 'blocking',
          header: read.recordSetId,
          message: `the table "${read.recordSetId}" is no longer in the new version of ${read.name}`,
        };
        report = {
          status: 'blocking',
          differences: [d],
          checkedColumns: read.fingerprint.columns.length,
          compiledDigest: read.fingerprint.digest,
          incomingDigest: read.fingerprint.digest,
        };
      } else report = detectDrift(read.fingerprint, fingerprintRecordSet(other));
    }
    out.push({
      sourceName: read.name,
      compiledSourceId: read.sourceId,
      incomingSourceId: newest?.sourceId ?? read.sourceId,
      tables: [{ recordSetId: read.recordSetId, report }],
      status: report.status,
    });
  }
  const status = out.some((s) => s.status === 'blocking') ? 'blocking' : out.some((s) => s.status === 'warning') ? 'warning' : 'none';
  return { status, sources: out, checkedSources: checked };
}

/** One plain sentence per blocking difference, for the refusal message. */
export function driftSummary(report: DataDriftReport): string {
  const lines = report.sources.flatMap((s) =>
    s.tables.flatMap((t) => t.report.differences.filter((d) => d.severity === 'blocking').map((d) => `${s.sourceName}: ${d.message}`)),
  );
  return `the data changed shape since this workflow was compiled, so nothing was run: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? `; and ${lines.length - 5} more` : ''}`;
}

/** UW-15: a digest of the schema of the tables a compilation was built from (null when it has none): half of the reuse key. */
export async function compiledSchemaDigest(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
  compilationId: string,
): Promise<Digest | null> {
  const compilations = new FsCompilationStore(workspaceCompilationsStore(workspace, config));
  const artifact = await compilations.getArtifact(compilationId);
  if (!artifact.ok) throw artifact.error;
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  const prints: [string, string][] = [];
  for (const entry of artifact.value.sourceSet.entries) {
    if (!/\.(csv|xlsx)$/i.test(entry.name)) continue;
    const bytes = await sources.getContent(entry.sourceId);
    const t = bytes.ok ? parse(entry.name, bytes.value) : undefined;
    for (const rs of t?.recordSets ?? []) prints.push([`${entry.name}#${rs.id}`, fingerprintRecordSet(rs).digest]);
  }
  return prints.length === 0 ? null : digestOf(prints.sort());
}
