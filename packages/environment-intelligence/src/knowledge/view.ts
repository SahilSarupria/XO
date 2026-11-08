import { strengthOf } from '../epistemic.js';
import { stableDigest } from '../ids.js';
import { entityIdOfKey, identifierKey, isStrongScheme, kindOfKey, keysOfRef, schemeOfKey, UNIQUE_SCHEMES } from './identifiers.js';
import {
  XOIR_EDGE_FOR,
  type Assertion,
  type ClaimCandidate,
  type ClaimItem,
  type ClaimOrigin,
  type ClaimValue,
  type ConflictItem,
  type DocumentItem,
  type EntityItem,
  type EntityRef,
  type ItemConfidence,
  type ItemProvenance,
  type KnowledgeKind,
  type MergeBasis,
  type RelationshipCandidate,
  type RelationshipItem,
  type RelationshipType,
  type ReviewDecision,
  type Scalar,
  type Validity,
} from './types.js';

/**
 * Explicit, versioned conflict-resolution policy (rule 5). It is configuration, never a hard-coded pick. Rules are tried in order;
 * a rule decides only when it yields ONE strictly best claim. Ties and rule exhaustion route to human review: there is no default winner.
 */
export type ResolutionRule =
  | { readonly kind: 'prefer_origin' } // observed > stated > inferred
  | { readonly kind: 'prefer_source'; readonly order: readonly string[] } // earlier source id wins; unlisted sources rank last (and tie)
  | { readonly kind: 'prefer_latest_effective' } // the claim whose validity began last
  | { readonly kind: 'prefer_corroborated' }; // more independent sources
export interface ResolutionPolicy {
  readonly id: string;
  readonly version: string;
  readonly rules: readonly ResolutionRule[];
}
/** The default policy has NO rules: every conflict goes to human review. */
export const NO_AUTOMATIC_RESOLUTION: ResolutionPolicy = Object.freeze({ id: 'none', version: '1', rules: Object.freeze([]) });

export interface ViewInput {
  /** Already restricted to assertions whose evidence is ELIGIBLE and VISIBLE to the caller. The view never widens this set. */
  readonly assertions: readonly Assertion[];
  readonly decisions: readonly ReviewDecision[];
  readonly policy: ResolutionPolicy;
  readonly asOf: string;
  readonly now: string;
}

export interface View {
  readonly entities: ReadonlyMap<string, EntityItem>;
  /** Maps every id an entity has answered to (identifier-derived ids) to its current id. */
  readonly entityIdFor: ReadonlyMap<string, string>;
  readonly relationships: readonly RelationshipItem[];
  readonly claims: readonly ClaimItem[];
  readonly conflicts: readonly ConflictItem[];
  readonly documents: readonly DocumentItem[];
}

const ms = (iso: string): number => Date.parse(iso);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const originRank: Readonly<Record<ClaimOrigin, number>> = { observed: 2, stated: 1, inferred: 0 };

function confidenceOf(origin: ClaimOrigin, independent: number): ItemConfidence {
  if (origin === 'inferred') {
    const corroborated = independent >= 2;
    const status = corroborated ? 'corroborated_inference' : 'candidate_hypothesis';
    return {
      status,
      strength: strengthOf(status),
      basis: 'inferred',
      corroboration: independent,
      calibrated: false,
      promotedToFact: corroborated,
    };
  }
  return {
    status: 'directly_observed',
    strength: 'strong',
    basis: origin,
    corroboration: independent,
    calibrated: false,
    promotedToFact: true,
  };
}

const strongest = (origins: readonly ClaimOrigin[]): ClaimOrigin =>
  origins.reduce<ClaimOrigin>((best, o) => (originRank[o] > originRank[best] ? o : best), 'inferred');

function provenanceOf(group: readonly Assertion[], now: string): ItemProvenance {
  const seen = new Map<string, Assertion['support']>();
  for (const a of group) seen.set(a.support.evidenceId, a.support);
  const derivations = new Map<string, Assertion['derivation']>();
  for (const a of group) derivations.set(a.derivation.derivationId, a.derivation);
  return {
    support: [...seen.values()].sort((x, y) => cmp(x.evidenceId, y.evidenceId)),
    derivations: [...derivations.values()].sort((x, y) => cmp(x.derivationId, y.derivationId)),
    lastVerifiedAt: now,
  };
}

const independentSources = (group: readonly Assertion[]): number => new Set(group.map((a) => a.support.sourceId)).size;
const docId = (sourceId: string, resourceDigest: string): string =>
  `doc_${stableDigest(['ei-doc-v1', sourceId, resourceDigest]).slice(0, 24)}`;

function validityOf(group: readonly Assertion[]): Validity {
  let start = Infinity;
  let by = '';
  let end: number | undefined = -Infinity;
  let endIso: string | undefined;
  for (const a of group) {
    const c = a.candidate;
    const from = c.type === 'entity' ? undefined : c.validFrom;
    const to = c.type === 'entity' ? undefined : c.validTo;
    const s = ms(from ?? a.support.observedAt);
    if (s < start || (s === start && a.support.evidenceId < by)) {
      start = s;
      by = a.support.evidenceId;
    }
    if (to === undefined) end = undefined;
    else if (end !== undefined && ms(to) > end) {
      end = ms(to);
      endIso = to;
    }
  }
  const first = group.find((a) => a.support.evidenceId === by);
  const fc = first?.candidate;
  const fromIso = fc !== undefined && fc.type !== 'entity' && fc.validFrom !== undefined ? fc.validFrom : (first?.support.observedAt ?? '');
  return { validFrom: fromIso, ...(end !== undefined && endIso !== undefined ? { validTo: endIso } : {}), establishedBy: by };
}

const validAt = (v: Validity, asOf: string): boolean =>
  ms(v.validFrom) <= ms(asOf) && (v.validTo === undefined || ms(asOf) < ms(v.validTo));

// ── union-find over identifier keys ───────────────────────────────────────────────────────────────────────────────────────

class Components {
  private readonly parent = new Map<string, string>();
  add(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k: string): string {
    let r = k;
    for (let p = this.parent.get(r); p !== undefined && p !== r; p = this.parent.get(r)) r = p;
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  members(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      out.set(r, [...(out.get(r) ?? []), k]);
    }
    for (const v of out.values()) v.sort(cmp);
    return out;
  }
}

interface Edge {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly kind: MergeBasis['kind'];
  readonly evidenceIds: readonly string[];
}

const refsOf = (a: Assertion): readonly EntityRef[] => {
  const c = a.candidate;
  return c.type === 'entity' ? [c.ref] : c.type === 'relationship' ? [c.from, c.to] : [c.subject];
};

const valueKey = (v: Scalar): string => `${typeof v}:${String(v)}`;

export function buildView(input: ViewInput): View {
  const { assertions, decisions, policy, asOf, now } = input;
  const ordered = [...assertions].sort((x, y) => cmp(x.id, y.id));

  // 1. nodes + edges ----------------------------------------------------------------------------------------------------
  const comps = new Components();
  const strongOf = (ref: EntityRef): string[] => keysOfRef(ref).filter((k) => isStrongScheme(schemeOfKey(k)));
  const weakOf = (ref: EntityRef): string[] => keysOfRef(ref).filter((k) => !isStrongScheme(schemeOfKey(k)));
  const edgeEvidence = new Map<string, { a: string; b: string; ev: Set<string> }>();
  const labelOwners = new Map<string, Set<string>>(); // weak key -> strong keys of refs that carry it as a label
  const mentions = new Map<string, Set<string>>(); // key -> evidence ids mentioning it
  const note = (k: string, ev: string): void => {
    mentions.set(k, (mentions.get(k) ?? new Set()).add(ev));
  };
  for (const a of ordered) {
    for (const ref of refsOf(a)) {
      const strong = strongOf(ref);
      const weak = weakOf(ref);
      for (const k of keysOfRef(ref)) note(k, a.support.evidenceId);
      for (const k of strong) comps.add(k);
      for (let i = 1; i < strong.length; i += 1) {
        const x = strong[0] as string;
        const y = strong[i] as string;
        const id = `${x}~${y}`;
        const cur = edgeEvidence.get(id) ?? { a: x, b: y, ev: new Set<string>() };
        cur.ev.add(a.support.evidenceId);
        edgeEvidence.set(id, cur);
      }
      if (strong.length === 0)
        for (const w of weak) comps.add(w); // a name-only mention is its own, unverified entity
      else for (const w of weak) labelOwners.set(w, (labelOwners.get(w) ?? new Set()).add(strong[0] as string));
    }
  }
  const edges: Edge[] = [...edgeEvidence.entries()].map(([id, e]) => ({
    id,
    a: e.a,
    b: e.b,
    kind: 'co_listed_identifiers' as const,
    evidenceIds: [...e.ev].sort(),
  }));
  const approved = decisions.filter((d) => d.kind === 'approve_merge' && d.subject.length === 2);
  for (const d of approved) {
    const [x, y] = d.subject as [string, string];
    if (kindOfKey(x) === kindOfKey(y) && mentions.has(x) && mentions.has(y))
      edges.push({ id: `~approved~${d.id}`, a: x, b: y, kind: 'human_approved', evidenceIds: [] });
  }
  const blocks = decisions
    .filter((d) => d.kind === 'block_merge' && d.subject.length === 2)
    .map((d) => d.subject as readonly [string, string]);

  // 2. apply edges under constraints (unique-scheme conflicts, human blocks) ------------------------------------------------
  const identityConflicts = new Map<string, { schemes: string; keys: string[]; evidence: Set<string> }>();
  const applied: Edge[] = [];
  edges.sort((p, q) => cmp(p.id, q.id));
  for (const e of edges) {
    const m = comps.members();
    const ra = comps.find(e.a);
    const rb = comps.find(e.b);
    if (ra === rb) {
      applied.push(e);
      continue;
    }
    const ma = m.get(ra) ?? [];
    const mb = m.get(rb) ?? [];
    const blocked = blocks.some(([x, y]) => (ma.includes(x) && mb.includes(y)) || (ma.includes(y) && mb.includes(x)));
    // A unique scheme (employee id, project key, ...) can hold ONE value per entity: joining two values would merge two different things.
    const clash = [...UNIQUE_SCHEMES].find((s) => {
      const va = new Set(ma.filter((k) => schemeOfKey(k) === s));
      const vb = new Set(mb.filter((k) => schemeOfKey(k) === s));
      return va.size > 0 && vb.size > 0 && [...va].some((k) => !vb.has(k));
    });
    if (clash !== undefined) {
      const keys = [...ma.filter((k) => schemeOfKey(k) === clash), ...mb.filter((k) => schemeOfKey(k) === clash)].sort(cmp);
      const id = `${clash}:${keys.join(',')}`;
      const cur = identityConflicts.get(id) ?? { schemes: clash, keys, evidence: new Set<string>() };
      for (const ev of e.evidenceIds) cur.evidence.add(ev);
      identityConflicts.set(id, cur);
      continue;
    }
    if (blocked) continue;
    comps.union(e.a, e.b);
    applied.push(e);
  }

  // 3. entities ---------------------------------------------------------------------------------------------------------------
  const members = comps.members();
  const keyToEntity = new Map<string, string>();
  const entityKeys = new Map<string, string[]>();
  for (const [, keys] of members) {
    const strongKeys = keys.filter((k) => isStrongScheme(schemeOfKey(k)));
    const id = entityIdOfKey((strongKeys[0] ?? keys[0]) as string);
    entityKeys.set(id, keys);
    for (const k of keys) keyToEntity.set(k, id);
  }
  const entityOfRef = (ref: EntityRef): string | undefined => {
    const keys = keysOfRef(ref);
    const strong = keys.filter((k) => isStrongScheme(schemeOfKey(k)));
    return keyToEntity.get((strong[0] ?? keys[0]) as string);
  };
  const byEntity = new Map<string, Assertion[]>();
  for (const a of ordered)
    for (const ref of refsOf(a)) {
      const id = entityOfRef(ref);
      if (id !== undefined) byEntity.set(id, [...(byEntity.get(id) ?? []), a]);
    }

  const entityIdFor = new Map<string, string>();
  const mergeCandidates = new Map<string, Set<string>>();
  const addCandidate = (x: string, y: string): void => {
    if (x === y) return;
    mergeCandidates.set(x, (mergeCandidates.get(x) ?? new Set()).add(y));
    mergeCandidates.set(y, (mergeCandidates.get(y) ?? new Set()).add(x));
  };
  for (const [weak, owners] of labelOwners) {
    const ents = new Set<string>();
    for (const o of owners) {
      const e = keyToEntity.get(o);
      if (e !== undefined) ents.add(e);
    }
    const weakOnly = keyToEntity.get(weak);
    if (weakOnly !== undefined) ents.add(weakOnly); // a name-only mention of the same name
    const list = [...ents].sort(cmp);
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) addCandidate(list[i] as string, list[j] as string);
  }

  const entities = new Map<string, EntityItem>();
  for (const [id, keys] of [...entityKeys.entries()].sort((x, y) => cmp(x[0], y[0]))) {
    const group = byEntity.get(id) ?? [];
    const hasStrong = keys.some((k) => isStrongScheme(schemeOfKey(k)));
    const sources = independentSources(group);
    const merges: MergeBasis[] = [];
    for (const e of applied.filter((x) => keyToEntity.get(x.a) === id).sort((p, q) => cmp(p.id, q.id)))
      merges.push({ kind: e.kind, identifierKeys: [e.a, e.b], evidenceIds: e.evidenceIds });
    for (const k of keys) {
      const ev = [...(mentions.get(k) ?? [])].sort();
      if (keys.length > 1 && isStrongScheme(schemeOfKey(k)) && ev.length >= 2)
        merges.push({ kind: 'shared_identifier', identifierKeys: [k], evidenceIds: ev });
    }
    const aliases = keys.map(entityIdOfKey).filter((a) => a !== id);
    // Weak identifiers (names) a record listed next to this entity's strong ones are LABELS: shown, never used to merge.
    const labels = [...labelOwners.entries()].filter(([, owners]) => keys.some((k) => owners.has(k))).map(([w]) => w);
    const shown = [...new Set([...keys, ...labels])].sort(cmp);
    for (const a of [id, ...aliases]) entityIdFor.set(a, id);
    const status = hasStrong ? ('directly_observed' as const) : ('candidate_hypothesis' as const);
    entities.set(id, {
      type: 'entity',
      id,
      kind: kindOfKey(keys[0] as string),
      identifiers: shown,
      aliases,
      merges,
      confidence: {
        status,
        strength: strengthOf(status),
        basis: 'observed',
        corroboration: sources,
        calibrated: false,
        promotedToFact: hasStrong,
      },
      provenance: provenanceOf(group, now),
      mergeCandidates: [...(mergeCandidates.get(id) ?? [])].sort(cmp),
    });
  }

  // 4. relationships ----------------------------------------------------------------------------------------------------------
  const relGroups = new Map<string, { c: RelationshipCandidate; from: string; to: string; group: Assertion[] }>();
  for (const a of ordered) {
    const c = a.candidate;
    if (c.type !== 'relationship') continue;
    const from = entityOfRef(c.from);
    const to = entityOfRef(c.to);
    if (from === undefined || to === undefined) continue;
    const key = [c.relation, from, to, c.origin].join('|');
    const cur = relGroups.get(key);
    if (cur === undefined) relGroups.set(key, { c, from, to, group: [a] });
    else cur.group.push(a);
  }
  const relationships: RelationshipItem[] = [];
  const documentsOf = new Map<string, DocumentItem>();
  for (const a of ordered)
    documentsOf.set(a.support.evidenceId, {
      type: 'document',
      id: docId(a.support.sourceId, a.support.resourceDigest),
      sourceId: a.support.sourceId,
      observedAt: a.support.observedAt,
      contentHash: a.support.contentHash,
      evidenceId: a.support.evidenceId,
    });
  for (const [key, g] of [...relGroups.entries()].sort((x, y) => cmp(x[0], y[0]))) {
    const validity = validityOf(g.group);
    if (!validAt(validity, asOf)) continue;
    const map = XOIR_EDGE_FOR[g.c.relation];
    relationships.push({
      type: 'relationship',
      id: `rel_${stableDigest(['ei-rel-v1', key]).slice(0, 24)}`,
      relation: g.c.relation,
      xoirEdge: map.edge,
      from: g.from,
      to: g.to,
      origin: g.c.origin,
      validity,
      confidence: confidenceOf(g.c.origin, independentSources(g.group)),
      provenance: provenanceOf(g.group, now),
    });
  }

  // 5. claims, history, conflicts ---------------------------------------------------------------------------------------------
  const SINGLE_VALUED: ReadonlySet<RelationshipType> = new Set(['manages']);
  interface Pending {
    readonly subject: string;
    readonly kind: KnowledgeKind;
    readonly predicate: string;
    readonly byValue: Map<string, { value: Scalar; group: Assertion[]; origins: ClaimOrigin[] }>;
  }
  const pending = new Map<string, Pending>();
  const addClaim = (subject: string, kind: KnowledgeKind, predicate: string, value: Scalar, origin: ClaimOrigin, a: Assertion): void => {
    const k = [subject, kind, predicate].join('|');
    const p = pending.get(k) ?? { subject, kind, predicate, byValue: new Map() };
    const v = p.byValue.get(valueKey(value)) ?? { value, group: [], origins: [] };
    v.group.push(a);
    v.origins.push(origin);
    p.byValue.set(valueKey(value), v);
    pending.set(k, p);
  };
  for (const a of ordered) {
    const c = a.candidate;
    if (c.type === 'claim') {
      const subject = entityOfRef((c as ClaimCandidate).subject);
      if (subject !== undefined) addClaim(subject, c.kind, c.predicate, c.value, c.origin, a);
    } else if (c.type === 'relationship' && SINGLE_VALUED.has(c.relation) && c.origin !== 'inferred') {
      // A person has ONE manager at a time: two different current managers are a contradiction, not two facts.
      const to = entityOfRef(c.to);
      const from = entityOfRef(c.from);
      if (to !== undefined && from !== undefined) addClaim(to, 'fact', `${c.relation}:by`, from, c.origin, a);
    }
  }

  const toValue = (v: { value: Scalar; group: Assertion[]; origins: ClaimOrigin[] }): ClaimValue => {
    const origin = strongest(v.origins);
    return {
      value: v.value,
      origin,
      validity: validityOf(v.group),
      confidence: confidenceOf(origin, independentSources(v.group)),
      provenance: provenanceOf(v.group, now),
      documents: [...new Set(v.group.map((a) => documentsOf.get(a.support.evidenceId)?.id ?? ''))].filter((d) => d !== '').sort(cmp),
    };
  };
  const claims: ClaimItem[] = [];
  const conflicts: ConflictItem[] = [];
  const humanResolve = decisions.filter((d) => d.kind === 'resolve_conflict' && d.subject.length === 2);

  for (const [pk, p] of [...pending.entries()].sort((x, y) => cmp(x[0], y[0]))) {
    const all = [...p.byValue.values()]
      .map(toValue)
      .sort((x, y) => cmp(x.validity.validFrom, y.validity.validFrom) || cmp(valueKey(x.value), valueKey(y.value)));
    const facts = all.filter((v) => v.confidence.promotedToFact);
    const hypotheses = all.filter((v) => !v.confidence.promotedToFact);
    const valid = facts.filter((v) => validAt(v.validity, asOf));
    const id = `clm_${stableDigest(['ei-claim-v1', pk]).slice(0, 24)}`;
    let status: ClaimItem['status'] = valid.length === 0 ? 'unknown' : 'known';
    let current: ClaimValue | undefined = valid.length === 1 ? valid[0] : undefined;
    let conflictId: string | undefined;
    if (valid.length > 1) {
      // The id must not depend on the ORDER the values were observed in: that order follows observation times, which differ on every
      // re-derivation, and a durable review decision is keyed by this id. Sorted, the same disagreement always has the same id.
      conflictId = `cfl_${stableDigest(['ei-conflict-v1', pk, ...valid.map((v) => valueKey(v.value)).sort(cmp)]).slice(0, 24)}`;
      const decided = resolve(valid, policy, humanResolve, conflictId);
      conflicts.push({
        type: 'conflict',
        id: conflictId,
        subject: p.subject,
        predicate: p.predicate,
        kind: p.kind,
        claims: valid,
        state: decided.by === 'none' ? 'open' : 'resolved',
        resolution: decided.resolution,
      });
      if (decided.winner !== undefined) current = decided.winner;
      else status = 'conflicted';
    }
    claims.push({
      type: 'claim',
      id,
      kind: p.kind,
      subject: p.subject,
      predicate: p.predicate,
      ...(current !== undefined ? { current } : {}),
      history: facts,
      hypotheses,
      status,
      ...(conflictId !== undefined ? { conflict: conflictId } : {}),
    });
  }
  for (const ic of identityConflicts.values()) {
    const ev = [...ic.evidence].sort(cmp);
    const group = ordered.filter((a) => ev.includes(a.support.evidenceId));
    const values: ClaimValue[] = ic.keys.map((k) => ({
      value: k.slice(k.indexOf(':') + 1),
      origin: 'observed' as const,
      validity: validityOf(group.length > 0 ? group : ordered.slice(0, 1)),
      confidence: confidenceOf('observed', independentSources(group)),
      provenance: provenanceOf(group, now),
      documents: [],
    }));
    const subject = keyToEntity.get(ic.keys[0] as string) ?? '';
    conflicts.push({
      type: 'conflict',
      id: `cfl_${stableDigest(['ei-identity-conflict-v1', ic.schemes, ...ic.keys]).slice(0, 24)}`,
      subject,
      predicate: `identity:${ic.schemes}`,
      kind: 'fact',
      claims: values,
      state: 'open',
      resolution: { by: 'none', route: 'human_review' },
    });
  }

  return {
    entities,
    entityIdFor,
    relationships,
    claims,
    conflicts: conflicts.sort((x, y) => cmp(x.id, y.id)),
    documents: [...documentsOf.values()].sort((x, y) => cmp(x.id, y.id)),
  };
}

interface Decided {
  readonly by: 'none' | 'policy' | 'human';
  readonly winner?: ClaimValue;
  readonly resolution: ConflictItem['resolution'];
}

function resolve(valid: readonly ClaimValue[], policy: ResolutionPolicy, human: readonly ReviewDecision[], conflictId: string): Decided {
  // A human decision names the conflict AND the winning value; if the conflict has changed shape, it no longer matches and does nothing.
  for (const d of human) {
    if (d.subject[0] !== conflictId) continue;
    const winner = valid.find((v) => valueKey(v.value) === d.subject[1]);
    if (winner !== undefined) return { by: 'human', winner, resolution: { by: 'human', decisionId: d.id, winner: winner.value } };
  }
  for (const rule of policy.rules) {
    const score = (v: ClaimValue): number => {
      switch (rule.kind) {
        case 'prefer_origin':
          return originRank[v.origin];
        case 'prefer_source': {
          const idx = Math.min(...v.provenance.support.map((s) => rule.order.indexOf(s.sourceId)).map((i) => (i < 0 ? Infinity : i)));
          return Number.isFinite(idx) ? rule.order.length - idx : 0;
        }
        case 'prefer_latest_effective':
          return ms(v.validity.validFrom);
        case 'prefer_corroborated':
          return v.confidence.corroboration;
      }
    };
    const scored = valid.map((v) => ({ v, s: score(v) }));
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best);
    if (top.length === 1 && top[0] !== undefined)
      return {
        by: 'policy',
        winner: top[0].v,
        resolution: { by: 'policy', policy: `${policy.id}@${policy.version}`, rule: rule.kind, winner: top[0].v.value },
      };
  }
  return { by: 'none', resolution: { by: 'none', route: 'human_review' } };
}

export { identifierKey };
export const valueDigest = (v: Scalar): string => valueKey(v);
