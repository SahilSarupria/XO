import { digestOf, idOf } from '../canonical.js';
import type { ChangeOperation, ClaimRecord, EvidenceRef } from '../types.js';
import type { ResolutionReport } from './resolver.js';

export const RESOLUTION_PREDICATE = 'xo-resolution:same-as';
export const RESOLUTION_METHOD = { kind: 'system', name: 'xo-entity-resolver', version: '1' } as const;

export interface ResolutionClaimContext {
  readonly tenantId: string;
  readonly relationship: string;
  readonly recordedAt: string;
  /** Evidence for each item ref: where the subject / candidate was read (source digest + locator). Required: no evidence, no claim. */
  readonly evidenceByRef: Readonly<Record<string, EvidenceRef>>;
}

/**
 * Results as `proposed` claims (ADR 0040): only `resolved` results become claims, as ADD operations in a change set that a person
 * with the review role approves (the existing change-set flow, which needs a recent sign-in). Ambiguous and unmatched results
 * are never turned into claims. Text and ids carry refs, never names or cell values.
 */
export function resolutionChangeOperations(report: ResolutionReport, ctx: ResolutionClaimContext): readonly ChangeOperation[] {
  const ops: ChangeOperation[] = [];
  for (const r of report.results) {
    if (r.outcome !== 'resolved') continue;
    for (const c of r.candidates) {
      const evidence = [ctx.evidenceByRef[r.subject], ctx.evidenceByRef[c.candidate]].filter((e): e is EvidenceRef => e !== undefined);
      if (evidence.length < 2) continue;
      const body = { relationship: ctx.relationship, subject: r.subject, candidate: c.candidate, basis: c.basis, scheme: c.scheme ?? null };
      const record: ClaimRecord = {
        kind: 'claim',
        id: idOf('clm', { tenantId: ctx.tenantId, ...body }),
        tenantId: ctx.tenantId,
        type: 'xo-resolution:identity-match',
        evidence: evidence.map((e) => ({ ...e, method: RESOLUTION_METHOD })),
        derivation: 'system',
        confidence: c.basis === 'identifier' ? 0.99 : 0.9,
        recordedAt: ctx.recordedAt,
        subject: { literal: r.subject },
        predicate: RESOLUTION_PREDICATE,
        object: { value: c.candidate },
        polarity: 'positive',
        modality: 'fact',
        scope: ctx.relationship,
        authority: { level: 'source', basis: `entity resolution by ${c.basis}; proposed, awaiting a reviewer` },
        text: `${r.subject} is ${c.candidate} (${ctx.relationship}, by ${c.basis}; digest ${digestOf(body).slice(0, 19)})`,
        origin: 'inferred',
      };
      ops.push({ op: 'add', record });
    }
  }
  return ops;
}
