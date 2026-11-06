/**
 * Wire types and parsers for the Connect knowledge routes, which return the C6 SDK's `KnowledgeResponse<T>` unchanged
 * (packages/connect/docs/HTTP_CONTRACT.md). Only the fields Studio renders are parsed; the SDK's `item` (the full C5 structure) is ignored.
 */
import { WireParseError, arr, bool, num, obj, optStr, str } from './wire';

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => {
  const s = str(v, path);
  if (!(allowed as readonly string[]).includes(s)) throw new WireParseError(path, `one of ${allowed.join(' | ')}`);
  return s as T;
};

export type StatementStatus = 'known' | 'conflicted' | 'hypothesis' | 'unknown';
export type ClaimOrigin = 'observed' | 'stated' | 'inferred';

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly observedAt: string;
}

export interface Statement {
  readonly ref: string;
  readonly kind: 'entity' | 'claim' | 'relationship' | 'conflict';
  readonly text: string;
  readonly status: StatementStatus;
  readonly origin?: ClaimOrigin;
  readonly corroboration?: number;
  readonly validity?: { readonly validFrom: string; readonly validTo?: string };
  readonly evidence: readonly EvidenceReference[];
  readonly reviewRequired: boolean;
}

export interface Uncertainty {
  readonly conflicted: number;
  readonly hypotheses: number;
  readonly unknown: number;
  readonly reviewRequired: number;
  readonly singleSource: number;
}

export interface KnowledgeEnvelope<T> {
  readonly asOf: string;
  readonly uncertainty: Uncertainty;
  readonly data: T;
}

export interface SearchData {
  readonly statements: readonly Statement[];
  readonly truncated: boolean;
}

export interface ReviewItem {
  readonly kind: 'conflict' | 'unverified_inference' | 'merge_candidate';
  readonly ref: string;
  readonly summary: string;
  readonly statement: Statement;
}

export interface ReviewData {
  readonly items: readonly ReviewItem[];
  readonly truncated: boolean;
}

function parseEvidence(v: unknown, path: string): EvidenceReference {
  const o = obj(v, path);
  return {
    evidenceId: str(o['evidenceId'], `${path}.evidenceId`),
    sourceId: str(o['sourceId'], `${path}.sourceId`),
    contentHash: str(o['contentHash'], `${path}.contentHash`),
    observedAt: str(o['observedAt'], `${path}.observedAt`),
  };
}

export function parseStatement(v: unknown, path = 'statement'): Statement {
  const o = obj(v, path);
  const origin = o['origin'] === undefined ? undefined : oneOf(o['origin'], ['observed', 'stated', 'inferred'], `${path}.origin`);
  let corroboration: number | undefined;
  if (o['confidence'] !== undefined) {
    const c = obj(o['confidence'], `${path}.confidence`);
    if (c['calibrated'] !== false) throw new WireParseError(`${path}.confidence.calibrated`, 'false (confidence is never a probability)');
    corroboration = num(c['corroboration'], `${path}.confidence.corroboration`);
  }
  let validity: Statement['validity'];
  if (o['validity'] !== undefined) {
    const x = obj(o['validity'], `${path}.validity`);
    const to = optStr(x['validTo'], `${path}.validity.validTo`);
    validity = { validFrom: str(x['validFrom'], `${path}.validity.validFrom`), ...(to !== undefined ? { validTo: to } : {}) };
  }
  return {
    ref: str(o['ref'], `${path}.ref`),
    kind: oneOf(o['kind'], ['entity', 'claim', 'relationship', 'conflict'], `${path}.kind`),
    text: str(o['text'], `${path}.text`),
    status: oneOf(o['status'], ['known', 'conflicted', 'hypothesis', 'unknown'], `${path}.status`),
    ...(origin !== undefined ? { origin } : {}),
    ...(corroboration !== undefined ? { corroboration } : {}),
    ...(validity !== undefined ? { validity } : {}),
    evidence: arr(o['evidence'], `${path}.evidence`).map((e, i) => parseEvidence(e, `${path}.evidence[${i}]`)),
    reviewRequired: bool(o['reviewRequired'], `${path}.reviewRequired`),
  };
}

function envelope<T>(v: unknown, data: (d: unknown) => T): KnowledgeEnvelope<T> {
  const o = obj(v, 'body');
  const access = obj(o['access'], 'access');
  // Results are always the caller's visible scope only; a response that claims otherwise is not trusted.
  if (access['completeness'] !== 'visible_scope_only') throw new WireParseError('access.completeness', '"visible_scope_only"');
  const u = obj(o['uncertainty'], 'uncertainty');
  return {
    asOf: str(o['asOf'], 'asOf'),
    uncertainty: {
      conflicted: num(u['conflicted'], 'uncertainty.conflicted'),
      hypotheses: num(u['hypotheses'], 'uncertainty.hypotheses'),
      unknown: num(u['unknown'], 'uncertainty.unknown'),
      reviewRequired: num(u['reviewRequired'], 'uncertainty.reviewRequired'),
      singleSource: num(u['singleSource'], 'uncertainty.singleSource'),
    },
    data: data(o['data']),
  };
}

export const parseSearch = (v: unknown): KnowledgeEnvelope<SearchData> =>
  envelope(v, (d) => {
    const o = obj(d, 'data');
    return {
      statements: arr(o['statements'], 'data.statements').map((s, i) => parseStatement(s, `data.statements[${i}]`)),
      truncated: bool(o['truncated'], 'data.truncated'),
    };
  });

export const parseReview = (v: unknown): KnowledgeEnvelope<ReviewData> =>
  envelope(v, (d) => {
    const o = obj(d, 'data');
    return {
      items: arr(o['items'], 'data.items').map((x, i) => {
        const it = obj(x, `data.items[${i}]`);
        return {
          kind: oneOf(it['kind'], ['conflict', 'unverified_inference', 'merge_candidate'], `data.items[${i}].kind`),
          ref: str(it['ref'], `data.items[${i}].ref`),
          summary: str(it['summary'], `data.items[${i}].summary`),
          statement: parseStatement(it['statement'], `data.items[${i}].statement`),
        };
      }),
      truncated: bool(o['truncated'], 'data.truncated'),
    };
  });
