/**
 * UW-4a (ADR 0012 decision 6, ADR 0034) — the evidence resolver and the executable-use gate.
 *
 * Evidence RESOLVES when what it cites still stands: the source version exists, its stored bytes still hash to the cited digest,
 * the cited pages / sheet / row are inside it, and a cited quote (by text or by `quoteHash`) is found on the cited pages. The
 * resolver reads the stored source through a port (`EvidenceSourcePort`), so this package stays storage-agnostic; the API
 * implements the port over the workspace source store and the compiler's own readers.
 *
 * A record may FEED EXECUTION only when it is active in the state, interpreted by an installed pack, has authority (claims), is
 * in no unresolved conflict, and every evidence entry resolves (`executableKnowledge`). That one function is the gate: the
 * readiness certificate's knowledge gate and anything that hands knowledge to a run call it, and nothing else decides.
 */
import { createHash } from 'node:crypto';
import type { KnowledgeBase } from './knowledge-base.js';
import type { EvidenceRef, KnowledgeRecord, StateEntry } from './types.js';

/** What the resolver needs to know about one stored source version. */
export interface SourceView {
  readonly name: string;
  /** True when the stored bytes were re-hashed now and equal the digest asked for. */
  readonly digestVerified: boolean;
  /** Number of pages, when the source is paged. */
  readonly pageCount?: number;
  /** Text of each page (index 0 = page 1), when the source has extractable text. */
  readonly pageTexts?: readonly string[];
  /** Whole text, when the source has text but no pages. */
  readonly text?: string;
  /**
   * Pages with no text layer (scans). Their text was recovered (OCR, vision) when the source was compiled and cannot be re-read
   * here, so a quote on them is unverifiable rather than missing.
   */
  readonly unreadablePages?: readonly number[];
  /** Workbook sheets and their row counts, when the source is a workbook. */
  readonly sheets?: Readonly<Record<string, { readonly rows: number }>>;
  /**
   * UW-12a: this version is no longer the current one (the file changed, left its connected folder, or its connection was
   * retired). The bytes still verify, but knowledge resting on them is out of date until it is reviewed against the current file.
   */
  readonly retired?: { readonly at: string; readonly reason: string };
}

export interface EvidenceSourcePort {
  /** The stored source whose bytes have this SHA-256 (hex), or undefined when no stored source has it. */
  source(digestSha256: string): Promise<SourceView | undefined>;
  /**
   * UW-11b: the run view. The stored digest (`sha256:<hex>`, or `mismatch` when the manifest was changed after admission) of the
   * run manifest, or undefined when there is no such run. A port without it cannot verify evidence that came from a run.
   */
  runManifestDigest?(runId: string): Promise<string | undefined>;
}

export type EvidenceStatus =
  | 'resolved'
  | 'source_missing'
  | 'source_altered'
  /** UW-12a: the cited version is retired (superseded or gone from its connected folder). */
  | 'source_retired'
  | 'locator_out_of_range'
  | 'quote_hash_mismatch'
  | 'quote_not_found'
  | 'quote_unverifiable';

export interface EvidenceResolution {
  readonly index: number;
  readonly sourceDigestSha256: string;
  readonly sourceName: string;
  readonly status: EvidenceStatus;
  readonly detail: string;
  /**
   * Whether the record's own words (a claim's text, an entity's name) appear on the cited pages: a corroboration a reviewer can
   * see, not a requirement (a claim may be worded as a summary). `not_checked` when the source has no extractable text.
   */
  readonly words: 'found' | 'not_found' | 'not_checked';
}

export interface RecordResolution {
  readonly recordId: string;
  readonly resolved: boolean;
  readonly evidence: readonly EvidenceResolution[];
}

/** NFKC, lower case, letters and digits only, single spaces: the form quotes are hashed and compared in. */
export function normaliseQuote(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function quoteHashOf(words: string): string {
  return `sha256:${createHash('sha256').update(normaliseQuote(words)).digest('hex')}`;
}

/** The words a record stands on: what a person reads it as. */
export function recordWords(r: KnowledgeRecord): string {
  if (r.kind === 'claim') return r.text;
  if (r.kind === 'entity') return r.canonicalName;
  return '';
}

function textOn(view: SourceView, pages: readonly number[] | undefined): string | undefined {
  if (view.pageTexts !== undefined) {
    const chosen = pages !== undefined && pages.length > 0 ? pages.map((p) => view.pageTexts![p - 1] ?? '') : view.pageTexts;
    return chosen.join('\n');
  }
  return view.text;
}

/** Resolves one evidence entry against a source view. Pure. */
export function resolveOne(record: KnowledgeRecord, ev: EvidenceRef, index: number, view: SourceView | undefined): EvidenceResolution {
  const base = { index, sourceDigestSha256: ev.sourceDigestSha256, sourceName: ev.sourceName };
  if (view === undefined)
    return { ...base, status: 'source_missing', detail: 'no stored source has this exact content any more', words: 'not_checked' };
  if (!view.digestVerified)
    return { ...base, status: 'source_altered', detail: 'the stored bytes no longer match the cited digest', words: 'not_checked' };
  if (view.retired !== undefined)
    return {
      ...base,
      status: 'source_retired',
      detail:
        view.retired.reason === 'changed'
          ? `this version was replaced on ${view.retired.at.slice(0, 10)}: review it against the current file`
          : `this version is no longer in its connected folder (since ${view.retired.at.slice(0, 10)})`,
      words: 'not_checked',
    };
  const pages = ev.locator.pages;
  if (pages !== undefined && pages.length > 0) {
    const max = view.pageCount ?? view.pageTexts?.length;
    const bad = pages.filter((p) => !Number.isInteger(p) || p < 1 || (max !== undefined && p > max));
    if (bad.length > 0)
      return {
        ...base,
        status: 'locator_out_of_range',
        detail: `page ${bad.join(', ')} is outside the source (${max ?? 'unknown'} pages)`,
        words: 'not_checked',
      };
  }
  if (ev.locator.sheet !== undefined && view.sheets !== undefined) {
    const sheet = view.sheets[ev.locator.sheet];
    if (sheet === undefined)
      return {
        ...base,
        status: 'locator_out_of_range',
        detail: `sheet "${ev.locator.sheet}" is not in the workbook`,
        words: 'not_checked',
      };
    if (ev.locator.row !== undefined && (ev.locator.row < 1 || ev.locator.row > sheet.rows))
      return {
        ...base,
        status: 'locator_out_of_range',
        detail: `row ${ev.locator.row} is outside sheet "${ev.locator.sheet}" (${sheet.rows} rows)`,
        words: 'not_checked',
      };
  }
  const text = textOn(view, pages);
  const hay = text !== undefined ? ` ${normaliseQuote(text)} ` : undefined;
  const own = normaliseQuote(recordWords(record));
  const words: EvidenceResolution['words'] =
    hay === undefined || own.length === 0 ? 'not_checked' : hay.includes(` ${own} `) ? 'found' : 'not_found';
  // A cited quote must be found: its own text, or the record's words standing behind its hash.
  const quoted = ev.quote ?? (ev.quoteHash !== undefined ? recordWords(record) : undefined);
  if (quoted !== undefined) {
    if (ev.quoteHash !== undefined && quoteHashOf(quoted) !== ev.quoteHash)
      return { ...base, status: 'quote_hash_mismatch', detail: 'the quoted words do not match the hash recorded with the evidence', words };
    if (hay === undefined)
      return { ...base, status: 'quote_unverifiable', detail: 'the source has no extractable text to find the quote in', words };
    const q = normaliseQuote(quoted);
    const scanned = (pages ?? []).filter((p) => view.unreadablePages?.includes(p));
    if ((q.length === 0 || !hay.includes(` ${q} `)) && scanned.length > 0)
      return {
        ...base,
        status: 'quote_unverifiable',
        detail: `page ${scanned.join(', ')} has no text layer; its text was recovered when the source was compiled and cannot be re-read`,
        words,
      };
    if (q.length === 0 || !hay.includes(` ${q} `))
      return {
        ...base,
        status: 'quote_not_found',
        detail: pages !== undefined && pages.length > 0 ? `the quote is not on page ${pages.join(', ')}` : 'the quote is not in the source',
        words,
      };
  }
  return { ...base, status: 'resolved', detail: 'the cited source, location and quote stand', words };
}

/** Evidence from a run resolves while that run's manifest is the one the evidence cites. Without a run view it never resolves. */
async function resolveRun(ev: EvidenceRef, index: number, port: EvidenceSourcePort): Promise<EvidenceResolution> {
  const base = { index, sourceDigestSha256: ev.sourceDigestSha256, sourceName: ev.sourceName, words: 'not_checked' as const };
  if (port.runManifestDigest === undefined)
    return {
      ...base,
      status: 'quote_unverifiable',
      detail: 'run evidence needs the instance that holds the run; it cannot be verified here',
    };
  const stored = await port.runManifestDigest(ev.locator.run!.runId);
  if (stored === undefined) return { ...base, status: 'source_missing', detail: 'the run this evidence came from is no longer there' };
  if (stored !== `sha256:${ev.sourceDigestSha256}`)
    return { ...base, status: 'source_altered', detail: "the run's record no longer matches the digest the evidence cites" };
  return { ...base, status: 'resolved', detail: 'the run and its record stand' };
}

/** Resolves every evidence entry of a record. A record with no evidence resolves only when a person asserted it. */
export async function resolveRecordEvidence(
  record: KnowledgeRecord,
  port: EvidenceSourcePort,
  cache: Map<string, Promise<SourceView | undefined>> = new Map(),
): Promise<RecordResolution> {
  const out: EvidenceResolution[] = [];
  for (let i = 0; i < record.evidence.length; i++) {
    const ev = record.evidence[i]!;
    if (ev.locator.run !== undefined) {
      out.push(await resolveRun(ev, i, port));
      continue;
    }
    let view = cache.get(ev.sourceDigestSha256);
    if (view === undefined) {
      view = port.source(ev.sourceDigestSha256);
      cache.set(ev.sourceDigestSha256, view);
    }
    out.push(resolveOne(record, ev, i, await view));
  }
  const resolved = record.evidence.length === 0 ? record.derivation === 'human' : out.every((e) => e.status === 'resolved');
  return { recordId: record.id, resolved, evidence: out };
}

export interface ExecutableVerdict {
  readonly recordId: string;
  readonly executable: boolean;
  /** Why it may not feed execution; empty when it may. */
  readonly reasons: readonly string[];
  readonly lifecycle?: StateEntry['lifecycle'];
  readonly resolution?: RecordResolution;
}

export interface ExecutableKnowledge {
  readonly stateId: string;
  readonly verdicts: readonly ExecutableVerdict[];
  readonly executable: readonly string[];
  readonly refused: readonly ExecutableVerdict[];
}

/**
 * UAC-12 — the one executable-use gate. For the named records (default: every record of the state), a record may feed execution
 * only when ALL hold: it is in the state and `active` (approved through a change set; proposed, needs-review, rejected,
 * superseded and expired records never do); an installed pack interprets its type; a claim has authority; it is in no
 * unresolved conflict; every evidence entry resolves. Each refusal says why, in words a reviewer can act on.
 */
export async function executableKnowledge(
  kb: KnowledgeBase,
  stateId: string,
  port: EvidenceSourcePort,
  options: { readonly recordIds?: readonly string[] } = {},
): Promise<ExecutableKnowledge> {
  const state = await kb.state(stateId);
  const entries = new Map(state.entries.map((e) => [e.id, e]));
  const inConflict = new Map<string, string>();
  const lostTo = new Map<string, { conflict: string; prevailing: string }>();
  for (const c of state.conflicts) {
    if (c.status === 'unresolved') for (const id of c.claims) inConflict.set(id, c.id);
    else if (c.prevailing !== undefined)
      for (const id of c.claims) if (id !== c.prevailing) lostTo.set(id, { conflict: c.id, prevailing: c.prevailing });
  }
  const ids = options.recordIds ?? state.entries.map((e) => e.id);
  const cache = new Map<string, Promise<SourceView | undefined>>();
  // One read of the state's records (each checked against its digest by `records`).
  const records = new Map((await kb.records(stateId, { lifecycle: 'any' })).map((x) => [x.record.id, x.record]));
  const verdicts: ExecutableVerdict[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    if (entry === undefined) {
      verdicts.push({ recordId: id, executable: false, reasons: [`record ${id} is not in knowledge state ${stateId}`] });
      continue;
    }
    const reasons: string[] = [];
    if (entry.lifecycle !== 'active') reasons.push(`it is ${entry.lifecycle.replace('_', ' ')}, not approved`);
    if (entry.interpretation === 'unsupported') reasons.push('no installed knowledge pack interprets its type');
    const record = records.get(id);
    let resolution: RecordResolution | undefined;
    if (record !== undefined) {
      if (record.kind === 'claim' && (record.authority === undefined || record.authority.basis.trim() === ''))
        reasons.push('the claim has no authority');
      const conflict = inConflict.get(id);
      if (conflict !== undefined) reasons.push(`it is in unresolved conflict ${conflict}; a person must rule`);
      const lost = lostTo.get(id);
      if (lost !== undefined) reasons.push(`conflict ${lost.conflict} was resolved in favour of ${lost.prevailing}`);
      resolution = await resolveRecordEvidence(record, port, cache);
      if (!resolution.resolved)
        reasons.push(
          record.evidence.length === 0
            ? 'it has no evidence and was not asserted by a person'
            : `its evidence does not resolve: ${resolution.evidence
                .filter((e) => e.status !== 'resolved')
                .map((e) => `${e.sourceName}: ${e.detail}`)
                .join('; ')}`,
        );
    }
    verdicts.push({
      recordId: id,
      executable: reasons.length === 0,
      reasons,
      lifecycle: entry.lifecycle,
      ...(resolution !== undefined ? { resolution } : {}),
    });
  }
  return {
    stateId,
    verdicts,
    executable: verdicts.filter((v) => v.executable).map((v) => v.recordId),
    refused: verdicts.filter((v) => !v.executable),
  };
}
