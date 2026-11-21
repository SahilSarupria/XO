/**
 * UW-15 (ADR 0044) — has the data a compiled workflow reads changed shape? Compares each tabular source the compilation used (as it
 * was compiled: the exact bytes in its source set) with the NEWEST source of the same name in the workspace (next month's workbook).
 * No baseline is stored: the compiled bytes are the baseline. Reports headers, types and value shapes, never cell values.
 */
import { tabularFromCsv, tabularFromXlsx, type TabularSource } from '@xo/compiler';
import { detectDrift, digestOf, fingerprintRecordSet, type Digest, type DriftDifference, type DriftReport } from '@xo/pre-execution';
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

export async function checkDataDrift(workspace: WorkspaceRecord, config: WorkspaceDataConfig, compilationId: string): Promise<DataDriftReport> {
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
        const d: DriftDifference = { kind: 'table_missing', severity: 'blocking', header: rs.id, message: `the table "${rs.id}" is no longer in the new version of ${entry.name}` };
        return { recordSetId: rs.id, report: { status: 'blocking', differences: [d], checkedColumns: fp.columns.length, compiledDigest: fp.digest, incomingDigest: fp.digest } };
      }
      return { recordSetId: rs.id, report: detectDrift(fp, fingerprintRecordSet(other)) };
    });
    const status = tables.some((t) => t.report.status === 'blocking') ? 'blocking' : tables.some((t) => t.report.status === 'warning') ? 'warning' : 'none';
    out.push({ sourceName: entry.name, compiledSourceId: entry.sourceId, incomingSourceId: newest.sourceId, tables, status });
  }
  const status = out.some((s) => s.status === 'blocking') ? 'blocking' : out.some((s) => s.status === 'warning') ? 'warning' : 'none';
  return { status, sources: out, checkedSources: checked };
}

/** One plain sentence per blocking difference, for the refusal message. */
export function driftSummary(report: DataDriftReport): string {
  const lines = report.sources.flatMap((s) => s.tables.flatMap((t) => t.report.differences.filter((d) => d.severity === 'blocking').map((d) => `${s.sourceName}: ${d.message}`)));
  return `the data changed shape since this workflow was compiled, so nothing was run: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? `; and ${lines.length - 5} more` : ''}`;
}

/** UW-15: a digest of the schema of the tables a compilation was built from (null when it has none): half of the reuse key. */
export async function compiledSchemaDigest(workspace: WorkspaceRecord, config: WorkspaceDataConfig, compilationId: string): Promise<Digest | null> {
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
