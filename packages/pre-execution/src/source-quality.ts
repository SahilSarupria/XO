/**
 * PX-2 (gap PX-G09, spec §4.3): source quality as an enforced policy, with digest-bound waivers.
 *
 * Each source in a compilation artifact has a quality state (`@xo/types` `SourceQualityState`) and, when it is not
 * `trusted`, a list of FINDINGS — one per unread page, per page only a hosted model read, or for the text as a whole. The
 * policy, per state:
 *
 * | state      | compile | review | approve / ready                                           |
 * | ---------- | ------- | ------ | --------------------------------------------------------- |
 * | `trusted`  | yes     | yes    | yes                                                       |
 * | `degraded` | yes     | yes    | only with a waiver covering every finding                 |
 * | `partial`  | yes     | yes    | only with a waiver covering every finding (unread pages)  |
 * | `blocked`  | yes*    | yes    | never — there is no reading to waive                      |
 *
 * (*) A blocked source is compiled without semantic extraction.
 *
 * A WAIVER is a reviewer's recorded decision to accept specific findings for one source VERSION (its SHA-256), for a
 * stated reason. It names the exact findings it accepts; it does not carry over to another version of the source, and a
 * finding it does not name is not waived. Its digest covers everything it says, so a stored waiver cannot be edited
 * without detection. Who may record one is the API's authorization (reviewers, with a recent sign-in) — this module only
 * says what a valid waiver must contain and whether the waivers in hand cover a compilation.
 */
import type { SourceQualityState } from '@xo/types';
import { digestOf, type Digest } from './canonical.js';
import type { CompilationArtifact } from './compilation-artifact.js';

export interface QualityFinding {
  /** Stable key a waiver names: `page:<n>:unread`, `page:<n>:model-transcribed`, `text:degraded`, `text:blocked`. */
  readonly key: string;
  readonly detail: string;
  readonly page?: number;
}

export interface SourceQualityEntry {
  readonly name: string;
  readonly digestSha256: string;
  readonly state: SourceQualityState | 'not-applicable';
  readonly findings: readonly QualityFinding[];
}

interface ArtifactSourceView {
  readonly sourcePath: string;
  readonly qualityState?: SourceQualityState;
  readonly coverage?: { readonly entries?: readonly { page: number; status: string; reason?: string; recoveredBy?: string }[] };
}

/** The quality state and findings of every source in `artifact`, in source-set order. */
export function sourceQualityOf(artifact: CompilationArtifact): readonly SourceQualityEntry[] {
  const reports = (artifact.sources as readonly ArtifactSourceView[]) ?? [];
  return artifact.sourceSet.entries.map((entry) => {
    const report = reports.find((r) => r.sourcePath === entry.name);
    const state = report?.qualityState ?? 'not-applicable';
    const findings: QualityFinding[] = [];
    for (const page of report?.coverage?.entries ?? []) {
      if (page.status === 'unaccounted')
        findings.push({
          key: `page:${page.page}:unread`,
          page: page.page,
          detail: `page ${page.page} was not read (${page.reason ?? 'no reason recorded'})`,
        });
      if (page.status === 'ocr' && page.recoveredBy === 'model')
        findings.push({
          key: `page:${page.page}:model-transcribed`,
          page: page.page,
          detail: `page ${page.page} was read only by a hosted model and has not been checked by a person`,
        });
    }
    if (state === 'degraded' && findings.length === 0)
      findings.push({
        key: 'text:degraded',
        detail: 'the extracted text has a high share of tokens that look like reconstruction artifacts',
      });
    if (state === 'blocked') findings.push({ key: 'text:blocked', detail: 'the text could not be trusted; no semantic extraction ran' });
    return { name: entry.name, digestSha256: entry.digestSha256, state, findings };
  });
}

// ── waivers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SOURCE_WAIVER_SCHEMA = 'xo.source-waiver.v1';

export interface SourceWaiver {
  readonly schema: typeof SOURCE_WAIVER_SCHEMA;
  readonly waiverId: string;
  /** The source version the waiver is for. Another version of the same file is not covered. */
  readonly digestSha256: string;
  readonly sourceName: string;
  /** The quality state the reviewer saw. A source whose state has changed needs a new waiver. */
  readonly qualityState: 'degraded' | 'partial';
  /** The exact finding keys accepted, sorted. */
  readonly findings: readonly string[];
  /** What the waiver allows: approval of capabilities from this source, and readiness of workflows built on it. */
  readonly scope: readonly ('approval' | 'readiness')[];
  readonly reason: string;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly createdAt: string;
  /** The compilation the reviewer was looking at when they decided (provenance; not a limit on where the waiver applies). */
  readonly decidedOnArtifact?: Digest;
  readonly digest: Digest;
}

export interface WaiverInput {
  readonly entry: SourceQualityEntry;
  readonly reason: string;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly createdAt: string;
  readonly scope?: readonly ('approval' | 'readiness')[];
  readonly decidedOnArtifact?: Digest;
  /** Defaults to every current finding. A subset leaves the rest unwaived. */
  readonly findings?: readonly string[];
}

/** Creates a waiver for one source's findings. Throws for a trusted or blocked source, an empty reason, or unknown findings. */
export function createSourceWaiver(input: WaiverInput): SourceWaiver {
  const { entry } = input;
  if (entry.state !== 'degraded' && entry.state !== 'partial')
    throw new Error(
      entry.state === 'blocked'
        ? `"${entry.name}" is blocked: there is no reading to waive; fix or replace the source`
        : `"${entry.name}" is ${entry.state}: there is nothing to waive`,
    );
  if (input.reason.trim().length < 10) throw new Error('a waiver needs a reason a later reader can understand (10 characters or more)');
  const known = new Set(entry.findings.map((f) => f.key));
  const findings = [...(input.findings ?? [...known])].sort();
  for (const f of findings) if (!known.has(f)) throw new Error(`"${f}" is not a current finding for "${entry.name}"`);
  if (findings.length === 0) throw new Error('a waiver must name at least one finding');
  const scope = [...new Set(input.scope ?? ['approval', 'readiness'])].sort() as ('approval' | 'readiness')[];
  const body = {
    schema: SOURCE_WAIVER_SCHEMA,
    digestSha256: entry.digestSha256,
    sourceName: entry.name,
    qualityState: entry.state,
    findings,
    scope,
    reason: input.reason.trim(),
    actor: input.actor,
    createdAt: input.createdAt,
    ...(input.decidedOnArtifact !== undefined ? { decidedOnArtifact: input.decidedOnArtifact } : {}),
  } as const;
  const digest = digestOf(body);
  return { ...body, waiverId: `wvr_${digest.slice(7, 31)}`, digest };
}

/** Recomputes a stored waiver's digest and id. */
export function verifySourceWaiver(waiver: SourceWaiver): boolean {
  if (waiver.schema !== SOURCE_WAIVER_SCHEMA) return false;
  const { digest, waiverId, ...body } = waiver;
  const recomputed = digestOf(body);
  return recomputed === digest && waiverId === `wvr_${digest.slice(7, 31)}`;
}

// ── assessment ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type QualityGateStatus = 'pass' | 'pass-with-waivers' | 'blocked';

export interface SourceQualityAssessment {
  readonly status: QualityGateStatus;
  readonly sources: readonly (SourceQualityEntry & {
    readonly unwaived: readonly QualityFinding[];
    readonly waivers: readonly string[];
  })[];
  /** One line per problem a person must act on. Empty when the status is not `blocked`. */
  readonly blockers: readonly string[];
  readonly appliedWaivers: readonly SourceWaiver[];
  readonly rejectedWaivers: readonly { readonly waiverId: string; readonly reason: string }[];
}

/**
 * Whether the sources of `artifact` may be relied on for `purpose`, given the waivers in hand. A waiver applies only to the
 * same source version and quality state, covers only the findings it names, and only for the purposes in its scope; a
 * waiver whose digest does not verify is rejected and reported.
 */
export function assessSourceQuality(
  artifact: CompilationArtifact,
  waivers: readonly SourceWaiver[],
  purpose: 'approval' | 'readiness',
): SourceQualityAssessment {
  const rejected: { waiverId: string; reason: string }[] = [];
  const valid = waivers.filter((w) => {
    if (!verifySourceWaiver(w)) {
      rejected.push({ waiverId: w.waiverId, reason: 'its digest does not match its content' });
      return false;
    }
    return true;
  });
  const applied = new Map<string, SourceWaiver>();
  const blockers: string[] = [];
  const sources = sourceQualityOf(artifact).map((entry) => {
    if (entry.state === 'trusted' || entry.state === 'not-applicable') return { ...entry, unwaived: [], waivers: [] };
    if (entry.state === 'blocked') {
      blockers.push(
        `"${entry.name}" is blocked: its text could not be trusted, so nothing read from it can be ${purpose === 'approval' ? 'approved' : 'relied on'}`,
      );
      return { ...entry, unwaived: entry.findings, waivers: [] };
    }
    const mine = valid.filter((w) => w.digestSha256 === entry.digestSha256 && w.qualityState === entry.state && w.scope.includes(purpose));
    const covered = new Set(mine.flatMap((w) => w.findings));
    const unwaived = entry.findings.filter((f) => !covered.has(f.key));
    const used = mine.filter((w) => w.findings.some((k) => entry.findings.some((f) => f.key === k)));
    for (const w of used) applied.set(w.waiverId, w);
    if (unwaived.length > 0)
      blockers.push(
        `"${entry.name}" is ${entry.state}: ${unwaived.length} finding(s) without a waiver (${unwaived
          .slice(0, 5)
          .map((f) => f.detail)
          .join('; ')}${unwaived.length > 5 ? '; …' : ''})`,
      );
    return { ...entry, unwaived, waivers: used.map((w) => w.waiverId) };
  });
  for (const w of valid)
    if (!applied.has(w.waiverId) && sources.some((s) => s.digestSha256 === w.digestSha256) && w.scope.includes(purpose)) {
      const s = sources.find((x) => x.digestSha256 === w.digestSha256)!;
      if (s.state !== w.qualityState)
        rejected.push({ waiverId: w.waiverId, reason: `it was recorded for a ${w.qualityState} reading; the source is now ${s.state}` });
    }
  const status: QualityGateStatus = blockers.length > 0 ? 'blocked' : applied.size > 0 ? 'pass-with-waivers' : 'pass';
  return { status, sources, blockers, appliedWaivers: [...applied.values()], rejectedWaivers: rejected };
}
