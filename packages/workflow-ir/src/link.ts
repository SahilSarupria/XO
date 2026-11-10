import { canonicalJson, sha256Hex } from './semantics.js';
import type { ConnectorDecl, Trigger, WorkflowComponent, WorkflowDef } from './types.js';

/**
 * Loading several XOs' workflows together (SPECIFICATION.md v1.1, EXPERIENCE_COMPILER.md §5). Overlaps are reported, conflicts are resolved ONLY by
 * a declared precedence order, and anything unresolved is **blocked and reported for a human**: the linker never guesses and never merges two
 * differing definitions. Blocking propagates: a workflow that depends on a blocked connector is blocked too.
 */

export interface PrecedencePolicy {
  /** XO ids, highest precedence first. An XO not listed cannot win a conflict. */
  readonly order: readonly string[];
}

export interface LinkInput {
  readonly xo: string;
  readonly component: WorkflowComponent;
}

export type LinkConflictKind = 'workflow' | 'connector' | 'webhook_route' | 'directory_source';

export interface LinkConflict {
  readonly kind: LinkConflictKind;
  readonly key: string;
  readonly xos: readonly string[];
  /** `precedence:<xo>` when the policy decided, `unresolved` when it could not (the contested items are blocked). */
  readonly resolution: string;
}

export interface LinkResult {
  readonly component: WorkflowComponent;
  /** Identical definitions present in more than one XO; deduplicated, harmless. */
  readonly overlaps: readonly { readonly kind: 'workflow' | 'connector'; readonly key: string; readonly xos: readonly string[] }[];
  readonly conflicts: readonly LinkConflict[];
  /** Workflow ids left out because a conflict was unresolved or they depend on a blocked connector. A person must resolve these. */
  readonly blocked: readonly { readonly workflow: string; readonly xo: string; readonly reason: string }[];
  readonly hasUnresolved: boolean;
}

const fp = (v: unknown): string => sha256Hex(canonicalJson(v));

function winner(xos: readonly string[], policy: PrecedencePolicy): string | undefined {
  const ranked = xos.map((x) => ({ x, i: policy.order.indexOf(x) })).filter((r) => r.i >= 0);
  if (ranked.length === 0) return undefined;
  ranked.sort((a, b) => a.i - b.i);
  return ranked[0]?.x;
}

export function linkWorkflowComponents(inputs: readonly LinkInput[], policy: PrecedencePolicy): LinkResult {
  const overlaps: LinkResult['overlaps'][number][] = [];
  const conflicts: LinkConflict[] = [];
  const blocked: { workflow: string; xo: string; reason: string }[] = [];

  // connectors by id
  const connByKey = new Map<string, { xo: string; decl: ConnectorDecl }[]>();
  for (const i of inputs)
    for (const c of i.component.connectors) connByKey.set(c.id, [...(connByKey.get(c.id) ?? []), { xo: i.xo, decl: c }]);
  const connectors: ConnectorDecl[] = [];
  const blockedConnectors = new Set<string>();
  for (const [id, defs] of connByKey) {
    const distinct = new Set(defs.map((d) => fp(d.decl)));
    const xos = defs.map((d) => d.xo);
    if (distinct.size === 1) {
      connectors.push((defs[0] as { decl: ConnectorDecl }).decl);
      if (defs.length > 1) overlaps.push({ kind: 'connector', key: id, xos });
      continue;
    }
    const w = winner(xos, policy);
    conflicts.push({ kind: 'connector', key: id, xos, resolution: w !== undefined ? `precedence:${w}` : 'unresolved' });
    if (w === undefined) blockedConnectors.add(id);
    else connectors.push((defs.find((d) => d.xo === w) as { decl: ConnectorDecl }).decl);
  }

  // workflows by id
  const wfByKey = new Map<string, { xo: string; wf: WorkflowDef }[]>();
  for (const i of inputs) for (const w of i.component.workflows) wfByKey.set(w.id, [...(wfByKey.get(w.id) ?? []), { xo: i.xo, wf: w }]);
  let chosen: { xo: string; wf: WorkflowDef }[] = [];
  for (const [id, defs] of wfByKey) {
    const xos = defs.map((d) => d.xo);
    if (new Set(defs.map((d) => fp(d.wf))).size === 1) {
      chosen.push(defs[0] as { xo: string; wf: WorkflowDef });
      if (defs.length > 1) overlaps.push({ kind: 'workflow', key: id, xos });
      continue;
    }
    const w = winner(xos, policy);
    conflicts.push({ kind: 'workflow', key: id, xos, resolution: w !== undefined ? `precedence:${w}` : 'unresolved' });
    if (w === undefined)
      for (const d of defs)
        blocked.push({ workflow: id, xo: d.xo, reason: 'two XOs define this workflow differently and no precedence applies' });
    else chosen.push(defs.find((d) => d.xo === w) as { xo: string; wf: WorkflowDef });
  }

  // trigger collisions between the chosen workflows
  const claim = (
    kind: 'webhook_route' | 'directory_source',
    key: string,
    who: { xo: string; wf: WorkflowDef },
  ): { xo: string; wf: WorkflowDef }[] =>
    chosen.filter(
      (c) =>
        c !== who &&
        c.wf.triggers.some((t: Trigger) =>
          kind === 'webhook_route' ? t.kind === 'webhook' && t.route === key : t.kind === 'directory' && `${t.source}` === key,
        ),
    );
  const seen = new Set<string>();
  for (const c of [...chosen]) {
    for (const t of c.wf.triggers) {
      const kind = t.kind === 'webhook' ? 'webhook_route' : t.kind === 'directory' ? 'directory_source' : undefined;
      if (kind === undefined) continue;
      const key = t.kind === 'webhook' ? t.route : (t as { source: string }).source;
      const id = `${kind}:${key}`;
      if (seen.has(id)) continue;
      const rivals = claim(kind, key, c);
      if (rivals.length === 0) continue;
      seen.add(id);
      const all = [c, ...rivals];
      const w = winner(
        all.map((r) => r.xo),
        policy,
      );
      conflicts.push({ kind, key, xos: all.map((r) => r.xo), resolution: w !== undefined ? `precedence:${w}` : 'unresolved' });
      for (const r of all)
        if (w === undefined || r.xo !== w) {
          blocked.push({
            workflow: r.wf.id,
            xo: r.xo,
            reason:
              w === undefined ? `shares ${kind} "${key}" with another XO and no precedence applies` : `loses ${kind} "${key}" to ${w}`,
          });
          chosen = chosen.filter((x) => x !== r);
        }
    }
  }

  // blocking propagates through connectors
  const final: WorkflowDef[] = [];
  for (const c of chosen) {
    const used = c.wf.steps.flatMap((s) => (s.type === 'act' || s.type === 'compensate' ? [s.connector] : []));
    const bad = used.find((u) => blockedConnectors.has(u));
    if (bad !== undefined)
      blocked.push({ workflow: c.wf.id, xo: c.xo, reason: `depends on connector "${bad}" whose definitions conflict` });
    else final.push(c.wf);
  }
  const usedIds = new Set(final.flatMap((w) => w.steps.flatMap((s) => (s.type === 'act' || s.type === 'compensate' ? [s.connector] : []))));
  const component: WorkflowComponent = {
    formatVersion: '1.0',
    semanticsVersion: inputs[0]?.component.semanticsVersion ?? '1.0',
    connectors: connectors.filter((c) => usedIds.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : 1)),
    workflows: final.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  return {
    component,
    overlaps,
    conflicts,
    blocked,
    hasUnresolved: conflicts.some((c) => c.resolution === 'unresolved') || blocked.length > 0,
  };
}

/**
 * The same linking discipline for the other things XOs carry and share by id: decision trees, knowledge entries and safety rules
 * (EXPERIENCE_COMPILER.md §5). An item present in several XOs is an overlap when the definitions are identical (kept once) and a conflict when they
 * differ. A conflict is decided ONLY by the declared precedence order; with no listed XO among the contenders it is unresolved and BLOCKED, never
 * guessed or merged field by field. For `safety`, blocking has a stronger consequence: the caller must not run the linked set while any safety rule is
 * unresolved (`hasUnresolved`), because a missing rule is a weaker XO, not a smaller one.
 * Not done: judging whether two DIFFERENT ids say contradictory things (that needs semantic comparison; only same-id disagreement is detected).
 */
export type ArtifactKind = 'tree' | 'knowledge' | 'safety';

export interface ArtifactSet<T extends { readonly id: string }> {
  readonly xo: string;
  readonly items: readonly T[];
}

export interface ArtifactLink<T extends { readonly id: string }> {
  readonly kind: ArtifactKind;
  readonly items: readonly T[];
  readonly overlaps: readonly { readonly id: string; readonly xos: readonly string[] }[];
  readonly conflicts: readonly { readonly id: string; readonly xos: readonly string[]; readonly resolution: string }[];
  /** Ids left out because the conflict was unresolved. */
  readonly blocked: readonly string[];
  readonly hasUnresolved: boolean;
}

export function linkArtifacts<T extends { readonly id: string }>(
  kind: ArtifactKind,
  sets: readonly ArtifactSet<T>[],
  policy: PrecedencePolicy,
): ArtifactLink<T> {
  const byId = new Map<string, { xo: string; item: T }[]>();
  for (const s of sets) {
    const seen = new Set<string>();
    for (const item of s.items) {
      if (seen.has(item.id)) throw new Error(`${s.xo}: duplicate ${kind} id "${item.id}" inside one XO`);
      seen.add(item.id);
      byId.set(item.id, [...(byId.get(item.id) ?? []), { xo: s.xo, item }]);
    }
  }
  const items: T[] = [];
  const overlaps: { id: string; xos: string[] }[] = [];
  const conflicts: { id: string; xos: string[]; resolution: string }[] = [];
  const blocked: string[] = [];
  for (const [id, defs] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    const distinct = new Set(defs.map((d) => fp(d.item)));
    const xos = defs.map((d) => d.xo);
    if (distinct.size === 1) {
      items.push((defs[0] as { item: T }).item);
      if (defs.length > 1) overlaps.push({ id, xos });
      continue;
    }
    const w = winner(xos, policy);
    if (w === undefined) {
      conflicts.push({ id, xos, resolution: 'unresolved' });
      blocked.push(id);
    } else {
      conflicts.push({ id, xos, resolution: `precedence:${w}` });
      items.push((defs.find((d) => d.xo === w) as { item: T }).item);
    }
  }
  return { kind, items, overlaps, conflicts, blocked, hasUnresolved: blocked.length > 0 };
}
