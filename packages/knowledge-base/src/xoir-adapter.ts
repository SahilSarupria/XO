/**
 * The one XOIR → BKB reconciliation boundary (spec §4.6 "XOIR ↔ BKB integration", mapping version `xoir-bkb.v1`).
 *
 * XOIR stays the compilation interchange; the BKB is where organizational knowledge is governed. This adapter turns one
 * compiled graph into a PROPOSED change set against the tenant's current head, and reports what it did:
 *
 *   accepted    new records
 *   unchanged   records already active in the head (recompiling the same sources proposes nothing new)
 *   updated     a record with the same identity (same source file, same subject and predicate) but new content:
 *               proposed as a supersession of the old one, never an overwrite
 *   conflicting claims that will conflict with active ones (both are kept; the conflict is recorded)
 *   unresolved  entities whose identity is ambiguous (several exact matches, or only similar names): added for review,
 *               never merged
 *   rejected    nodes that cannot become records (no evidence)
 *   unsupported nodes of kinds the mapping does not carry, listed so nothing disappears silently
 *
 * Mapping (core vocabulary `xo:`, generic, no domain nouns):
 *   concept (any subtype)                         → entity     `xo:concept.<subtype>`
 *   heuristic / decision_node / constraint / fact / safety_policy / risk_policy / escalation_rule
 *                                                 → claim      predicate `xo:<kind>`, subject = condition or rule text
 *   capability                                    → claim      predicate `xo:capability`
 *   edges between mapped nodes                    → relationship `xo:edge.<KIND>`
 * Each record keeps the XOIR node id in its evidence (`locator.xoirNodeId`) and the exact source version and position.
 */
import { digestOf, idOf } from './canonical.js';
import type { KnowledgeBase, Actor } from './knowledge-base.js';
import type {
  ChangeOperation,
  ChangeSet,
  ClaimRecord,
  EntityRecord,
  EvidenceRef,
  KnowledgeRecord,
  ReconciliationReport,
  RelationshipRecord,
} from './types.js';

export const XOIR_BKB_MAPPING_VERSION = 'xoir-bkb.v1';

/** The structural view of a compiled graph the adapter needs (XOIR's `toJson` output satisfies it). */
export interface XoirGraphView {
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly metadata: {
      readonly subtype?: string;
      readonly confidence?: number;
      readonly sourceRefs?: readonly {
        readonly documentPath: string;
        readonly pages?: readonly number[];
        readonly sectionPath?: readonly string[];
        readonly charOffsetRange?: readonly [number, number];
      }[];
    };
  }[];
  readonly edges: readonly { readonly id: string; readonly kind: string; readonly fromId: string; readonly toId: string }[];
}

export interface ReconcileContext {
  /** Compiler source id (`documentPath` in node refs) → the source version it was read from. */
  readonly sources: ReadonlyMap<string, { readonly name: string; readonly digestSha256: string }>;
  readonly origin: ChangeSet['origin'];
  readonly proposedBy: Actor;
  readonly recordedAt: string;
}

const CLAIM_KINDS = new Set([
  'heuristic',
  'decision_node',
  'constraint',
  'fact',
  'safety_policy',
  'risk_policy',
  'escalation_rule',
  'capability',
]);
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function claimShape(kind: string, p: Readonly<Record<string, unknown>>): { subject: string; object: Record<string, string>; text: string } {
  switch (kind) {
    case 'heuristic':
      return { subject: str(p['condition']), object: { action: str(p['action']) }, text: `If ${str(p['condition'])}, ${str(p['action'])}` };
    case 'decision_node':
      return { subject: str(p['question']), object: { outcome: str(p['outcome']) }, text: `${str(p['question'])} → ${str(p['outcome'])}` };
    case 'constraint':
      return {
        subject: str(p['rule']),
        object: { rule: str(p['rule']), severity: str(p['severity']) },
        text: str(p['summary']) || str(p['rule']),
      };
    case 'fact':
      return { subject: str(p['statement']), object: { statement: str(p['statement']) }, text: str(p['statement']) };
    case 'capability':
      return {
        subject: str(p['name']),
        object: { name: str(p['name']), description: str(p['description']) },
        text: `${str(p['name'])}: ${str(p['description'])}`,
      };
    default:
      return {
        subject: str(p['policy']) || str(p['rule']) || str(p['trigger']),
        object: { value: JSON.stringify(p) },
        text: str(p['policy']) || JSON.stringify(p),
      };
  }
}

/** Builds the change set operations and report for `graph` against the tenant's head; proposes them when there are any. */
export async function reconcileXoirGraph(
  kb: KnowledgeBase,
  graph: XoirGraphView,
  ctx: ReconcileContext,
): Promise<{ readonly changeSet: ChangeSet | undefined; readonly report: ReconciliationReport }> {
  const head = await kb.head();
  const activeIds = new Set(head.entries.filter((e) => e.lifecycle === 'active').map((e) => e.id));
  const headRecords = await kb.records(head.stateId);
  const identityOf = new Map<string, string>(); // identity key → active record id
  for (const { record } of headRecords) identityOf.set(identityKey(record), record.id);

  const report = {
    accepted: [] as string[],
    unchanged: [] as string[],
    updated: [] as string[],
    conflicting: [] as string[],
    unresolved: [] as { ref: string; reason: string }[],
    rejected: [] as { ref: string; reason: string }[],
    unsupported: [] as string[],
  };
  const ops: ChangeOperation[] = [];
  const nodeToRecord = new Map<string, string>();

  const evidenceFor = (n: XoirGraphView['nodes'][number]): EvidenceRef[] =>
    (n.metadata.sourceRefs ?? []).flatMap((ref) => {
      const src = ctx.sources.get(ref.documentPath);
      if (src === undefined) return [];
      return [
        {
          sourceDigestSha256: src.digestSha256,
          sourceName: src.name,
          locator: {
            ...(ref.pages !== undefined ? { pages: ref.pages } : {}),
            ...(ref.sectionPath !== undefined ? { section: ref.sectionPath } : {}),
            ...(ref.charOffsetRange !== undefined ? { charRange: ref.charOffsetRange } : {}),
            xoirNodeId: n.id,
          },
          method: { kind: 'source' as const, name: '@xo/compiler', version: XOIR_BKB_MAPPING_VERSION },
        },
      ];
    });

  const place = (record: KnowledgeRecord, nodeId: string): void => {
    nodeToRecord.set(nodeId, record.id);
    if (activeIds.has(record.id)) {
      if (!report.unchanged.includes(record.id)) report.unchanged.push(record.id);
      return;
    }
    if (ops.some((o) => o.op === 'add' && o.record.id === record.id)) return;
    const previous = identityOf.get(identityKey(record));
    if (previous !== undefined && previous !== record.id) {
      ops.push({ op: 'supersede', recordId: previous, by: record });
      report.updated.push(record.id);
    } else {
      ops.push({ op: 'add', record });
      report.accepted.push(record.id);
    }
  };

  // Entities first (claims and relationships refer to them).
  for (const n of graph.nodes) {
    if (n.kind !== 'concept') continue;
    const evidence = evidenceFor(n);
    if (evidence.length === 0) {
      report.rejected.push({ ref: n.id, reason: 'no evidence in a known source version' });
      continue;
    }
    const name = (str(n.properties['definition']) || str(n.properties['name']) || n.id).slice(0, 200);
    const type = `xo:concept.${(n.metadata.subtype ?? 'concept').replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const resolution = await kb.resolveEntity(head.stateId, { name, type });
    if (resolution.status === 'linked') {
      nodeToRecord.set(n.id, resolution.entityId!);
      if (!report.unchanged.includes(resolution.entityId!)) report.unchanged.push(resolution.entityId!);
      continue;
    }
    if (resolution.candidates.length > 0)
      report.unresolved.push({
        ref: n.id,
        reason: `"${name}" may be ${resolution.candidates.map((c) => `${c.entityId} (${c.method}, ${c.score})`).join(' or ')}; added as a separate entity for review, not merged`,
      });
    const record: EntityRecord = {
      kind: 'entity',
      id: idOf('ent', { tenant: kb.tenantId, type, name: norm(name) }),
      tenantId: kb.tenantId,
      type,
      canonicalName: name,
      aliases: Array.isArray(n.properties['aliases'])
        ? (n.properties['aliases'] as unknown[]).filter((a): a is string => typeof a === 'string')
        : [],
      identifiers: [],
      attributes: {},
      evidence,
      derivation: 'source',
      confidence: n.metadata.confidence ?? 0,
      recordedAt: ctx.recordedAt,
    };
    place(record, n.id);
  }

  for (const n of graph.nodes) {
    if (n.kind === 'concept') continue;
    if (!CLAIM_KINDS.has(n.kind)) {
      report.unsupported.push(`${n.id} (${n.kind})`);
      continue;
    }
    const evidence = evidenceFor(n);
    if (evidence.length === 0) {
      report.rejected.push({ ref: n.id, reason: 'no evidence in a known source version' });
      continue;
    }
    const shape = claimShape(n.kind, n.properties);
    const modality = str(n.properties['modality']) || n.metadata.subtype;
    const polarity = str(n.properties['polarity']) === 'negative' ? 'negative' : 'positive';
    const content = {
      predicate: `xo:${n.kind}`,
      subject: norm(shape.subject),
      object: shape.object,
      polarity,
      modality,
      evidence: evidence.map((e) => [e.sourceDigestSha256, e.locator.charRange ?? null, e.locator.pages ?? null]),
    };
    const record: ClaimRecord = {
      kind: 'claim',
      id: idOf('clm', { tenant: kb.tenantId, ...content }),
      tenantId: kb.tenantId,
      type: `xo:${n.kind}`,
      subject: { literal: shape.subject },
      predicate: `xo:${n.kind}`,
      object: { value: shape.object },
      polarity,
      ...(modality === 'obligation' || modality === 'prohibition' || modality === 'permission' || modality === 'advisory'
        ? { modality }
        : {}),
      authority: { level: 'source', basis: `stated in ${evidence.map((e) => e.sourceName).join(', ')}` },
      text: shape.text,
      evidence,
      derivation: 'source',
      confidence: n.metadata.confidence ?? 0,
      recordedAt: ctx.recordedAt,
    };
    place(record, n.id);
  }

  for (const e of graph.edges) {
    const from = nodeToRecord.get(e.fromId);
    const to = nodeToRecord.get(e.toId);
    if (from === undefined || to === undefined) continue;
    const fromNode = graph.nodes.find((n) => n.id === e.fromId)!;
    const evidence = evidenceFor(fromNode);
    if (evidence.length === 0) continue;
    const type = `xo:edge.${e.kind.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const record: RelationshipRecord = {
      kind: 'relationship',
      id: idOf('rel', { tenant: kb.tenantId, type, from, to }),
      tenantId: kb.tenantId,
      type,
      from,
      to,
      directed: true,
      evidence,
      derivation: 'source',
      confidence: 1,
      recordedAt: ctx.recordedAt,
    };
    place(record, e.id);
  }

  // Claims proposed here that will conflict with claims already active (both are kept; the state records the conflict).
  const proposedClaims = ops
    .flatMap((o) => (o.op === 'add' || o.op === 'supersede' ? [o.op === 'add' ? o.record : o.by] : []))
    .filter((r): r is ClaimRecord => r.kind === 'claim');
  const activeClaims = headRecords.map((x) => x.record).filter((r): r is ClaimRecord => r.kind === 'claim');
  for (const c of proposedClaims) {
    const clash = activeClaims.find(
      (a) =>
        a.predicate === c.predicate &&
        norm('literal' in a.subject ? a.subject.literal : '') === norm('literal' in c.subject ? c.subject.literal : '') &&
        (digestOf(a.object) !== digestOf(c.object) || a.polarity !== c.polarity),
    );
    if (clash !== undefined) report.conflicting.push(c.id);
  }

  const changeSet = await kb.propose({ operations: ops, origin: ctx.origin, report, proposedBy: ctx.proposedBy });
  return { changeSet, report };
}

/** What makes two records "the same thing" across recompiles: kind, type, subject, and the source FILE (not its version). */
function identityKey(r: KnowledgeRecord): string {
  const files = [...new Set(r.evidence.map((e) => e.sourceName))].sort().join('|');
  if (r.kind === 'entity') return `entity|${r.type}|${norm(r.canonicalName)}`;
  if (r.kind === 'claim') {
    const loc = r.evidence
      .map((e) => (e.locator.section ?? []).join('>'))
      .sort()
      .join('|');
    return `claim|${r.predicate}|${norm('literal' in r.subject ? r.subject.literal : r.subject.entityId)}|${files}|${loc}`;
  }
  return `rel|${r.type}|${r.from}|${r.to}`;
}
