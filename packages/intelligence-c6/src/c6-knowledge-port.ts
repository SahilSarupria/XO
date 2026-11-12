import type { KnowledgeSdk, SdkErrorCode, Statement, StatementStatus } from '@xo/environment-intelligence';
import { isAuthenticatedPrincipal } from '@xo/permissions';
import { UnconfiguredKnowledgePort, type Evidence, type KnowledgePort, type KnowledgeQuery, type KnowledgeResult } from '@xo/intelligence';

/**
 * The C6 boundary: `KnowledgePort` over the C6 Knowledge Agent SDK.
 *
 * This adapter contains NO retrieval logic. It does exactly four things:
 *   1. Identity — hands C6 the caller's server-minted `AuthenticatedPrincipal` (carried on `Principal.authenticated`).
 *      No credential, or one that does not match the caller, means no call is made: fail closed, never a fabricated principal.
 *   2. Mapping — turns C6 `Statement`s into `Evidence`, keeping what C6 knows about certainty: a conflicted, hypothetical
 *      or unknown statement is labelled as such IN the text the model reads, and single-source statements say so.
 *   3. Errors — C6's fail-closed errors become distinct, honest outcomes (denied / unavailable), never an empty "not found".
 *   4. Honesty about method — C6 free-text query is deterministic LEXICAL retrieval (its own contract says so), so results
 *      are tagged `lexical` and the user is told.
 *
 * What it does not do, because C6 does not offer it: it cannot say which sources were withheld (C6 reports only what the
 * principal may see), it ignores `scope` (an installed-XO notion C6 does not have), and sources are shown by a short id
 * unless `describeSource` supplies display names (C6 evidence references carry only a source id).
 */
export interface C6KnowledgePortOptions {
  /** Only `query` is used. */
  readonly sdk: Pick<KnowledgeSdk, 'query'>;
  /** Optional display name / link for a C6 source id (e.g. from the EI inventory). */
  readonly describeSource?: (sourceId: string) => { readonly name: string; readonly uri?: string } | undefined;
  /** Longest question sent to C6. Default 500. */
  readonly maxQueryChars?: number;
}

const DENIED: ReadonlySet<SdkErrorCode> = new Set(['unauthenticated', 'denied']);

const STATUS_PREFIX: Record<StatementStatus, string> = {
  known: '',
  conflicted: 'CONFLICTED — the sources disagree and a person must decide: ',
  hypothesis: 'HYPOTHESIS — inferred, not confirmed: ',
  unknown: 'UNKNOWN — no value is established: ',
};

function toEvidence(s: Statement, describe: C6KnowledgePortOptions['describeSource']): Evidence {
  const first = s.evidence[0];
  const info = first !== undefined ? describe?.(first.sourceId) : undefined;
  const short = first !== undefined ? first.sourceId.slice(0, 14) : 'unknown';
  const more = s.evidence.length > 1 ? ` +${s.evidence.length - 1} more` : '';
  const support = s.evidence.length === 0 ? '' : s.evidence.length === 1 ? ' (single source)' : ` (${s.evidence.length} sources)`;
  const asOf = s.evidence.reduce<string | undefined>(
    (latest, e) => (latest === undefined || e.observedAt > latest ? e.observedAt : latest),
    undefined,
  );
  return {
    id: s.ref,
    sourceId: first?.sourceId ?? 'c6',
    sourceName: `${info?.name ?? `source ${short}`}${more}`,
    sourceType: `c6:${s.kind}`,
    ...(info?.uri !== undefined ? { uri: info.uri } : {}),
    excerpt: `${STATUS_PREFIX[s.status]}${s.text}${support}`,
    ...(asOf !== undefined ? { asOf } : {}),
  };
}

export class C6KnowledgePort implements KnowledgePort {
  constructor(private readonly options: C6KnowledgePortOptions) {}

  async retrieve(q: KnowledgeQuery): Promise<KnowledgeResult> {
    const credential = q.principal.authenticated;
    // The credential must be genuine AND be this caller's. A mismatch means something upstream is wrong: refuse.
    if (!isAuthenticatedPrincipal(credential) || credential.id !== q.principal.identityId) {
      return { status: 'unavailable', reason: 'denied' };
    }
    const text = q.query.trim().slice(0, this.options.maxQueryChars ?? 500);
    if (text.length === 0) return { status: 'ok', method: 'lexical', evidence: [] };

    const res = await this.options.sdk.query({ principal: credential, query: text, limit: Math.min(100, Math.max(1, q.limit)) });
    if (!res.ok) {
      return { status: 'unavailable', reason: DENIED.has(res.error.code) ? 'denied' : 'error' };
    }
    return { status: 'ok', method: 'lexical', evidence: res.value.data.statements.map((s) => toEvidence(s, this.options.describeSource)) };
  }
}

/**
 * Per-workspace composition for `createHttpServer({ intelligenceKnowledge })`. A workspace with no C6 environment gets an
 * explicit "not configured" port — it never silently falls back to another source, so a misconfiguration cannot make the
 * chat answer from the wrong place.
 */
export function c6KnowledgeFactory(options: {
  readonly sdkFor: (workspaceId: string) => Pick<KnowledgeSdk, 'query'> | undefined;
  readonly describeSource?: C6KnowledgePortOptions['describeSource'];
}): (workspace: { readonly workspaceId: string }) => KnowledgePort {
  return (workspace) => {
    const sdk = options.sdkFor(workspace.workspaceId);
    return sdk === undefined
      ? new UnconfiguredKnowledgePort()
      : new C6KnowledgePort({ sdk, ...(options.describeSource ? { describeSource: options.describeSource } : {}) });
  };
}
