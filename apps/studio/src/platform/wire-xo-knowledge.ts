/**
 * UW-12b (ADR 0052): wire parsers for the workspace knowledge routes (`/workspaces/{ws}/knowledge/…`). These are not the personal
 * Connect knowledge routes in `wire-knowledge.ts`; the two services answer different questions.
 */
import { WireParseError, arr, num, obj, str, strArr } from './wire';

export interface KnowledgeHead {
  readonly stateId: string;
  readonly parentStateId: string | null;
  readonly createdAt: string;
  readonly records: { readonly entity: number; readonly claim: number; readonly relationship: number };
  readonly conflicts: { readonly open: number; readonly total: number };
}

export function parseKnowledgeHead(v: unknown): KnowledgeHead {
  const o = obj(v, 'state');
  const count = { entity: 0, claim: 0, relationship: 0 };
  for (const [i, e] of arr(o['entries'] ?? [], 'state.entries').entries()) {
    const x = obj(e, `state.entries[${i}]`);
    if (x['lifecycle'] !== 'active') continue;
    const k = str(x['kind'], 'kind');
    if (k === 'entity' || k === 'claim' || k === 'relationship') count[k]++;
  }
  const conflicts = arr(o['conflicts'] ?? [], 'state.conflicts').map((c, i) => obj(c, `state.conflicts[${i}]`));
  return {
    stateId: str(o['stateId'], 'state.stateId'),
    parentStateId: o['parentStateId'] === null || o['parentStateId'] === undefined ? null : str(o['parentStateId'], 'state.parentStateId'),
    createdAt: str(o['createdAt'], 'state.createdAt'),
    records: count,
    conflicts: { open: conflicts.filter((c) => c['status'] === 'unresolved').length, total: conflicts.length },
  };
}

export interface KnowledgeHit {
  readonly recordId: string;
  readonly kind: string;
  readonly type: string;
  readonly text: string;
  readonly lifecycle: string;
  readonly evidence: number;
}
export function parseKnowledgeHits(v: unknown): readonly KnowledgeHit[] {
  return arr(obj(v, 'search')['hits'], 'search.hits').map((h, i): KnowledgeHit => {
    const x = obj(h, `search.hits[${i}]`);
    return {
      recordId: str(x['recordId'], 'recordId'),
      kind: str(x['kind'], 'kind'),
      type: str(x['type'], 'type'),
      text: str(x['text'], 'text'),
      lifecycle: str(x['lifecycle'], 'lifecycle'),
      evidence: arr(x['evidence'] ?? [], 'evidence').length,
    };
  });
}

export interface ConflictView {
  readonly id: string;
  readonly reason: string;
  readonly status: string;
}
export function parseKnowledgeConflicts(v: unknown): readonly ConflictView[] {
  return arr(obj(v, 'conflicts')['conflicts'], 'conflicts.conflicts').map((c, i): ConflictView => {
    const x = obj(c, `conflicts[${i}]`);
    return { id: str(x['id'], 'id'), reason: str(x['reason'], 'reason'), status: str(x['status'], 'status') };
  });
}

export interface ChangeSetView {
  readonly changeSetId: string;
  readonly status: 'proposed' | 'approved' | 'rejected';
  readonly origin: string;
  readonly ref?: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly operations: number;
  readonly findings: readonly { readonly severity: string; readonly message: string }[];
}
export function parseChangeSet(v: unknown, path = 'changeSet'): ChangeSetView {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (status !== 'proposed' && status !== 'approved' && status !== 'rejected')
    throw new WireParseError(`${path}.status`, 'proposed, approved or rejected');
  const origin = obj(o['origin'], `${path}.origin`);
  return {
    changeSetId: str(o['changeSetId'], `${path}.changeSetId`),
    status,
    origin: str(origin['kind'], `${path}.origin.kind`),
    ...(typeof origin['ref'] === 'string' ? { ref: origin['ref'] } : {}),
    proposedBy: str(obj(o['proposedBy'], `${path}.proposedBy`)['id'], `${path}.proposedBy.id`),
    proposedAt: str(o['proposedAt'], `${path}.proposedAt`),
    operations: arr(o['operations'] ?? [], `${path}.operations`).length,
    findings: arr(o['findings'] ?? [], `${path}.findings`).map((f, i) => {
      const x = obj(f, `${path}.findings[${i}]`);
      return { severity: str(x['severity'], 'severity'), message: str(x['message'], 'message') };
    }),
  };
}
export const parseChangeSets = (v: unknown): readonly ChangeSetView[] =>
  arr(obj(v, 'changeSets')['changeSets'], 'changeSets.changeSets').map((c, i) => parseChangeSet(c, `changeSets[${i}]`));

export interface ChangeSetPreviewView {
  readonly changeSetId: string;
  readonly stale: boolean;
  readonly diff: Readonly<
    Record<'added' | 'superseded' | 'retired' | 'restored' | 'merged' | 'conflictsOpened' | 'conflictsResolved', number>
  >;
  readonly findings: readonly { readonly severity: string; readonly message: string }[];
  readonly affected: {
    readonly count: number;
    readonly certificates: readonly { readonly certificateId: string; readonly definitionId?: string }[];
  };
}
export function parseChangeSetPreview(v: unknown): ChangeSetPreviewView {
  const o = obj(v, 'preview');
  const p = obj(o['preview'], 'preview.preview');
  const d = obj(p['diff'], 'preview.diff');
  const n = (k: string): number => strArr(d[k] ?? [], `diff.${k}`).length;
  const a = obj(o['affected'], 'preview.affected');
  return {
    changeSetId: str(p['changeSetId'], 'preview.changeSetId'),
    stale: p['stale'] === true,
    diff: {
      added: n('added'),
      superseded: n('superseded'),
      retired: n('retired'),
      restored: n('restored'),
      merged: n('merged'),
      conflictsOpened: n('conflictsOpened'),
      conflictsResolved: n('conflictsResolved'),
    },
    findings: arr(p['findings'] ?? [], 'preview.findings').map((f, i) => {
      const x = obj(f, `preview.findings[${i}]`);
      return { severity: str(x['severity'], 'severity'), message: str(x['message'], 'message') };
    }),
    affected: {
      count: num(a['count'], 'affected.count'),
      certificates: arr(a['certificates'] ?? [], 'affected.certificates').map((c, i) => {
        const x = obj(c, `affected.certificates[${i}]`);
        return {
          certificateId: str(x['certificateId'], 'certificateId'),
          ...(typeof x['definitionId'] === 'string' ? { definitionId: x['definitionId'] } : {}),
        };
      }),
    },
  };
}

export interface KnowledgeStateRow {
  readonly stateId: string;
  readonly parentStateId: string | null;
  readonly changeSetId: string | null;
  readonly createdAt: string;
}
export function parseKnowledgeStates(v: unknown): { readonly states: readonly KnowledgeStateRow[]; readonly total: number } {
  const o = obj(v, 'states');
  return {
    total: num(o['total'], 'states.total'),
    states: arr(o['states'], 'states.states').map((s, i): KnowledgeStateRow => {
      const x = obj(s, `states[${i}]`);
      return {
        stateId: str(x['stateId'], 'stateId'),
        parentStateId: x['parentStateId'] === null ? null : str(x['parentStateId'], 'parentStateId'),
        changeSetId: x['changeSetId'] === null ? null : str(x['changeSetId'], 'changeSetId'),
        createdAt: str(x['createdAt'], 'createdAt'),
      };
    }),
  };
}

export function parseVerify(v: unknown): { readonly verified: boolean; readonly findings: number } {
  const o = obj(v, 'verify');
  return { verified: o['verified'] === true, findings: arr(o['findings'] ?? [], 'verify.findings').length };
}

export interface KnowledgePackView {
  readonly packId: string;
  readonly namespace: string;
  readonly version: string;
}
export const parseKnowledgePacks = (v: unknown): readonly KnowledgePackView[] =>
  arr(obj(v, 'packs')['packs'], 'packs.packs').map((p, i): KnowledgePackView => {
    const x = obj(p, `packs[${i}]`);
    return { packId: str(x['packId'], 'packId'), namespace: str(x['namespace'], 'namespace'), version: str(x['version'], 'version') };
  });

export interface KnowledgeRecordRow {
  readonly recordId: string;
  readonly kind: string;
  readonly type: string;
  /** A short phrase naming what the record says: an entity's name, a claim's predicate, a relationship's type. */
  readonly label: string;
  readonly lifecycle: string;
  readonly evidence: number;
}
export function parseKnowledgeRecords(v: unknown): readonly KnowledgeRecordRow[] {
  return arr(obj(v, 'records')['records'], 'records.records').map((r, i): KnowledgeRecordRow => {
    const x = obj(r, `records[${i}]`);
    const entry = obj(x['entry'], `records[${i}].entry`);
    const rec = obj(x['record'], `records[${i}].record`);
    const kind = str(rec['kind'], 'kind');
    return {
      recordId: str(entry['id'], 'id'),
      kind,
      type: str(kind === 'claim' ? rec['predicate'] : rec['type'], 'type'),
      label:
        kind === 'entity' ? str(rec['canonicalName'], 'canonicalName') : str(kind === 'claim' ? rec['predicate'] : rec['type'], 'type'),
      lifecycle: str(entry['lifecycle'], 'lifecycle'),
      evidence: arr(rec['evidence'] ?? [], 'evidence').length,
    };
  });
}
