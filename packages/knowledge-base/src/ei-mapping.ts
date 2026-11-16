/**
 * UW-4a (ADR 0012 decision 7, ADR 0034) — environment-intelligence knowledge mapped onto the one claim model.
 *
 * Environment intelligence (EI, `@xo/environment-intelligence`) derives assertions from connected systems: entities, claims and
 * relationships, each with the evidence it came from and an epistemic status. This module turns them into BKB records for a
 * change set, so EI knowledge reaches the knowledge base the same way compiled knowledge does: proposed, reviewed, approved.
 * The shapes below mirror EI's types structurally, so this package keeps no dependency on EI.
 *
 * Status mapping (decision 7):
 *   directly_observed       → origin `observed`
 *   corroborated_inference  → origin `inferred`, only with at least two independent evidence entries (else a hypothesis)
 *   candidate_hypothesis    → origin `inferred`, proposed separately as a hypothesis (a person confirms it or not)
 *   unknown                 → no record: absence is not stored as a fact
 * Relationship kinds keep their EI names (`xo:relation.manages`, `xo:relation.associated_with`, …), which closes the two XOIR
 * edge gaps EI recorded (decision 5) without a new edge kind in the compiled graph.
 */
import { idOf } from './canonical.js';
import type { ClaimRecord, EntityRecord, EvidenceRef, KnowledgeRecord, RelationshipRecord } from './types.js';

export const EI_BKB_MAPPING_VERSION = '1';

export type EiEpistemicStatus = 'directly_observed' | 'corroborated_inference' | 'candidate_hypothesis' | 'unknown';

interface EiEntityRef {
  readonly kind: string;
  readonly identifiers: readonly { readonly scheme: string; readonly value: string }[];
}
export type EiCandidate =
  | { readonly type: 'entity'; readonly ref: EiEntityRef }
  | {
      readonly type: 'relationship';
      readonly relation: string;
      readonly from: EiEntityRef;
      readonly to: EiEntityRef;
      readonly origin: 'observed' | 'stated' | 'inferred';
      readonly validFrom?: string;
      readonly validTo?: string;
    }
  | {
      readonly type: 'claim';
      readonly kind: string;
      readonly subject: EiEntityRef;
      readonly predicate: string;
      readonly value: string | number | boolean;
      readonly origin: 'observed' | 'stated' | 'inferred';
      readonly validFrom?: string;
      readonly validTo?: string;
    };

export interface EiAssertionLike {
  readonly id: string;
  readonly candidate: EiCandidate;
  readonly support: { readonly sourceId: string; readonly resourceDigest: string; readonly observedAt: string };
  readonly derivation: { readonly deriverId: string; readonly deriverVersion: string };
  /** The status EI's view gives the statement this assertion supports (absent: directly observed). */
  readonly epistemicStatus?: EiEpistemicStatus;
}

export interface EiMappingResult {
  /** Records to propose as knowledge (entities they need included). */
  readonly records: readonly KnowledgeRecord[];
  /** Inferred claims without corroboration: proposed on their own, so approving them is a separate, explicit decision. */
  readonly hypotheses: readonly KnowledgeRecord[];
  /** Assertions that became no record, and why. */
  readonly skipped: readonly { readonly assertionId: string; readonly reason: string }[];
}

const slug = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unnamed';
const refKey = (r: EiEntityRef): string =>
  `${r.kind}|${[...r.identifiers]
    .map((i) => `${i.scheme}=${i.value}`)
    .sort()
    .join(',')}`;

export function mapEiAssertions(
  assertions: readonly EiAssertionLike[],
  ctx: { readonly tenantId: string; readonly recordedAt: string; readonly sourceName: (sourceId: string) => string },
): EiMappingResult {
  const skipped: { assertionId: string; reason: string }[] = [];
  const entities = new Map<string, EntityRecord>();
  const evidenceByKey = new Map<
    string,
    { evidence: EvidenceRef[]; sources: Set<string>; assertion: EiAssertionLike; status: EiEpistemicStatus }
  >();

  const evidenceOf = (a: EiAssertionLike): EvidenceRef | undefined => {
    const hex = a.support.resourceDigest.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
    return {
      sourceDigestSha256: hex,
      sourceName: ctx.sourceName(a.support.sourceId),
      locator: {},
      observedAt: a.support.observedAt,
      method: { kind: 'system', name: a.derivation.deriverId, version: a.derivation.deriverVersion },
    };
  };

  const entityFor = (ref: EiEntityRef, ev: EvidenceRef): EntityRecord => {
    const key = refKey(ref);
    const existing = entities.get(key);
    const type = `xo:entity.${slug(ref.kind)}`;
    const identifiers = [...ref.identifiers]
      .map((i) => ({ scheme: i.scheme, value: i.value }))
      .sort((a, b) => (a.scheme + a.value).localeCompare(b.scheme + b.value));
    const evidence =
      existing === undefined
        ? [ev]
        : existing.evidence.some((e) => e.sourceDigestSha256 === ev.sourceDigestSha256)
          ? existing.evidence
          : [...existing.evidence, ev];
    const record: EntityRecord = {
      kind: 'entity',
      id: idOf('ent', { tenant: ctx.tenantId, type, identifiers }),
      tenantId: ctx.tenantId,
      type,
      canonicalName: identifiers[0]?.value ?? ref.kind,
      aliases: identifiers.slice(1).map((i) => i.value),
      identifiers,
      attributes: {},
      evidence,
      derivation: 'system',
      confidence: 1,
      recordedAt: ctx.recordedAt,
    };
    entities.set(key, record);
    return record;
  };

  for (const a of assertions) {
    const status = a.epistemicStatus ?? 'directly_observed';
    if (status === 'unknown') {
      skipped.push({ assertionId: a.id, reason: 'status unknown: absence is not stored as a fact' });
      continue;
    }
    const ev = evidenceOf(a);
    if (ev === undefined) {
      skipped.push({ assertionId: a.id, reason: 'the evidence names no SHA-256 source version' });
      continue;
    }
    const c = a.candidate;
    const key =
      c.type === 'entity'
        ? `e|${refKey(c.ref)}`
        : c.type === 'claim'
          ? `c|${refKey(c.subject)}|${c.kind}|${c.predicate}|${JSON.stringify(c.value)}|${c.validFrom ?? ''}|${c.validTo ?? ''}`
          : `r|${c.relation}|${refKey(c.from)}|${refKey(c.to)}|${c.validFrom ?? ''}|${c.validTo ?? ''}`;
    const prev = evidenceByKey.get(key);
    if (prev === undefined) evidenceByKey.set(key, { evidence: [ev], sources: new Set([ev.sourceDigestSha256]), assertion: a, status });
    else {
      if (!prev.sources.has(ev.sourceDigestSha256)) prev.evidence.push(ev);
      prev.sources.add(ev.sourceDigestSha256);
      // The strongest status any supporting assertion has; corroboration is re-checked below on the merged evidence.
      if (status === 'directly_observed' || (status === 'corroborated_inference' && prev.status === 'candidate_hypothesis'))
        prev.status = status;
    }
  }

  const records: KnowledgeRecord[] = [];
  const hypotheses: KnowledgeRecord[] = [];
  for (const [, g] of evidenceByKey) {
    const c = g.assertion.candidate;
    const first = g.evidence[0]!;
    if (c.type === 'entity') {
      for (const ev of g.evidence) entityFor(c.ref, ev);
      continue;
    }
    // Decision 7: an inference is corroborated only by two independent sources; otherwise it is a hypothesis.
    const hypothesis = g.status === 'candidate_hypothesis' || (g.status === 'corroborated_inference' && g.sources.size < 2);
    const origin = g.status === 'directly_observed' ? c.origin : 'inferred';
    const validity =
      c.validFrom !== undefined || c.validTo !== undefined
        ? { ...(c.validFrom !== undefined ? { from: c.validFrom } : {}), ...(c.validTo !== undefined ? { to: c.validTo } : {}) }
        : undefined;
    let record: KnowledgeRecord;
    if (c.type === 'claim') {
      const subject = entityFor(c.subject, first);
      const predicate = `xo:${slug(c.kind)}.${slug(c.predicate)}`;
      const content = { tenant: ctx.tenantId, predicate, subject: subject.id, value: c.value, validity: validity ?? null, origin };
      const claim: ClaimRecord = {
        kind: 'claim',
        id: idOf('clm', content),
        tenantId: ctx.tenantId,
        type: predicate,
        subject: { entityId: subject.id },
        predicate,
        object: { value: c.value },
        polarity: 'positive',
        modality: 'fact',
        ...(validity !== undefined ? { validity } : {}),
        authority: { level: 'source', basis: `${origin} in ${[...new Set(g.evidence.map((e) => e.sourceName))].join(', ')}` },
        text: `${subject.canonicalName} ${c.predicate.replace(/_/g, ' ')}: ${String(c.value)}`,
        origin,
        evidence: g.evidence,
        derivation: 'system',
        confidence: hypothesis ? 0.5 : 1,
        recordedAt: ctx.recordedAt,
      };
      record = claim;
    } else {
      const from = entityFor(c.from, first);
      const to = entityFor(c.to, first);
      const type = `xo:relation.${slug(c.relation)}`;
      const rel: RelationshipRecord = {
        kind: 'relationship',
        id: idOf('rel', { tenant: ctx.tenantId, type, from: from.id, to: to.id, validity: validity ?? null }),
        tenantId: ctx.tenantId,
        type,
        from: from.id,
        to: to.id,
        directed: c.relation !== 'associated_with',
        ...(validity !== undefined ? { validity } : {}),
        evidence: g.evidence,
        derivation: 'system',
        confidence: hypothesis ? 0.5 : 1,
        recordedAt: ctx.recordedAt,
      };
      record = rel;
    }
    (hypothesis ? hypotheses : records).push(record);
  }
  return {
    records: [...entities.values(), ...records].sort((a, b) => a.id.localeCompare(b.id)),
    hypotheses: hypotheses.sort((a, b) => a.id.localeCompare(b.id)),
    skipped,
  };
}
