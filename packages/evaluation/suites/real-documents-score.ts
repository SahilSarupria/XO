/**
 * UW-3c — scoring XO's reading of a real document against a labelled reading of it.
 *
 * Every sentence or list item of a labelled document carries one expected READ (see sets/real-documents.json, `policy`):
 * `step` (an action in an ordered procedure), `criterion` (a checklist item), `rule` (an explicitly normative statement),
 * `action` (an instruction outside a procedure), `none` (must produce nothing) or `opt` (neutral). Scoring matches XO's
 * output nodes (capabilities, and the normative kinds) to those items by a distinctive phrase and classifies every miss by
 * failure mode, so a number always comes with the reason behind it.
 *
 * Matching is token based and tolerant of OCR noise: a phrase matches a node when nearly all its tokens occur in order in the
 * node's primary text (a capability's name, a constraint's rule), with a one-character edit allowed in longer tokens. A
 * capability whose (clause-cut) name is itself contained in the phrase also matches. Descriptions are never used: they hold
 * whole list items, so they would hide names built from the wrong text.
 */

export type Read = 'step' | 'criterion' | 'rule' | 'action' | 'none' | 'opt';

export interface LabelledItem {
  readonly id: string;
  readonly read: Read;
  readonly phrases: readonly string[];
  readonly modality?: string;
  readonly checkbox?: 'checked' | 'unchecked';
  readonly procedure?: string;
  readonly order?: number;
}

/** What scoring needs from one output node. */
export interface OutputNode {
  readonly id: string;
  /** `capability`, or a normative kind (`constraint`, `heuristic`, `decision_node`, `escalation_rule`, `risk_policy`). */
  readonly kind: string;
  /** The name (capability) or the rule text (normative). */
  readonly primary: string;
  readonly modality?: string;
  readonly checkbox?: string;
  /** Flagged by the compiler as a possible extraction error. */
  readonly flagged: boolean;
}

export interface ScoringInput {
  readonly items: readonly LabelledItem[];
  readonly nodes: readonly OutputNode[];
  /** Sequence edges between capabilities (from -> to). */
  readonly sequence: readonly { readonly from: string; readonly to: string }[];
  /** Text the compiler reported as not covered (uncovered sentences, review items): a miss found here was not silent. */
  readonly reported: readonly string[];
}

export type FailureMode =
  | 'missed-silently'
  | 'missed-reported'
  | 'wrong-kind'
  | 'wrong-modality'
  | 'wrong-checkbox'
  | 'order-lost'
  | 'duplicate'
  | 'spurious-from-non-content'
  | 'unmatched-output'
  | 'mixed-text';

export interface ItemOutcome {
  readonly id: string;
  readonly read: Read;
  readonly found: boolean;
  readonly kindOk: boolean;
  readonly modalityOk?: boolean;
  readonly checkboxOk?: boolean;
  readonly nodes: readonly string[];
}

export interface Score {
  readonly expected: number;
  readonly found: number;
  readonly kindCorrect: number;
  readonly modalityChecked: number;
  readonly modalityCorrect: number;
  readonly checkboxChecked: number;
  readonly checkboxCorrect: number;
  readonly orderPairs: number;
  readonly orderKept: number;
  /** Output nodes judged: those matching an expected or `none` item, or nothing. Nodes matching only `opt` items are neutral. */
  readonly judgedOutput: number;
  /** Judged output that represents an expected item with an acceptable kind. */
  readonly correctOutput: number;
  readonly failures: Readonly<Record<FailureMode, readonly string[]>>;
  readonly items: readonly ItemOutcome[];
}

const NORMATIVE = new Set(['constraint', 'heuristic', 'decision_node', 'escalation_rule', 'risk_policy']);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = (s: string): string[] => {
  const n = normalizeText(s);
  return n.length === 0 ? [] : n.split(' ');
};

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const sameToken = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b));

/** How many of `needle`'s tokens occur in order in `hay`, with at most two unmatched hay tokens between consecutive matches. */
function inOrderMatches(needle: readonly string[], hay: readonly string[]): number {
  let best = 0;
  for (let start = 0; start < hay.length; start++) {
    if (!sameToken(needle[0]!, hay[start]!) && !(needle.length > 3 && needle[1] !== undefined && sameToken(needle[1], hay[start]!)))
      continue;
    let h = start;
    let matched = 0;
    for (let n = 0; n < needle.length && h < hay.length; n++) {
      let k = h;
      while (k < hay.length && k - h <= 2 && !sameToken(needle[n]!, hay[k]!)) k++;
      if (k < hay.length && k - h <= 2) {
        matched++;
        h = k + 1;
      }
    }
    best = Math.max(best, matched);
    if (best === needle.length) break;
  }
  return best;
}

function phraseIn(phrase: string, text: string): boolean {
  const p = tokens(phrase);
  const t = tokens(text);
  if (p.length === 0 || t.length === 0) return false;
  const need = p.length <= 3 ? p.length : Math.ceil(p.length * 0.85);
  return inOrderMatches(p, t) >= need;
}

/** A node represents an item when the item's phrase is in its primary text, or its (clause-cut) primary text is in the phrase. */
export function represents(item: LabelledItem, node: OutputNode): boolean {
  for (const phrase of item.phrases) {
    if (phraseIn(phrase, node.primary)) return true;
    const own = tokens(node.primary);
    if (node.kind === 'capability' && own.length >= 3 && inOrderMatches(own, tokens(phrase)) >= Math.ceil(own.length * 0.85)) return true;
  }
  return false;
}

const acceptable = (read: Read, kind: string): boolean => {
  if (read === 'step') return kind === 'capability';
  if (read === 'criterion' || read === 'rule') return NORMATIVE.has(kind);
  if (read === 'action') return kind === 'capability' || NORMATIVE.has(kind);
  return false;
};

const EXPECTED: ReadonlySet<Read> = new Set(['step', 'criterion', 'rule', 'action']);

export function scoreDocument(input: ScoringInput): Score {
  const failures: Record<FailureMode, string[]> = {
    'missed-silently': [],
    'missed-reported': [],
    'wrong-kind': [],
    'wrong-modality': [],
    'wrong-checkbox': [],
    'order-lost': [],
    duplicate: [],
    'spurious-from-non-content': [],
    'unmatched-output': [],
    'mixed-text': [],
  };
  const nodes = input.nodes.filter((n) => n.kind === 'capability' || NORMATIVE.has(n.kind));
  const matchesOf = new Map<string, LabelledItem[]>();
  for (const n of nodes)
    matchesOf.set(
      n.id,
      input.items.filter((i) => represents(i, n)),
    );

  const outcomes: ItemOutcome[] = [];
  let found = 0;
  let kindCorrect = 0;
  let modalityChecked = 0;
  let modalityCorrect = 0;
  let checkboxChecked = 0;
  let checkboxCorrect = 0;
  const reported = input.reported.join('\n');
  for (const item of input.items.filter((i) => EXPECTED.has(i.read))) {
    const mine = nodes.filter((n) => matchesOf.get(n.id)!.includes(item));
    const good = mine.filter((n) => acceptable(item.read, n.kind));
    const isFound = mine.length > 0;
    if (!isFound) {
      const flagged = item.phrases.some((p) => phraseIn(p, reported));
      failures[flagged ? 'missed-reported' : 'missed-silently'].push(item.id);
    } else found++;
    if (isFound && good.length > 0) kindCorrect++;
    else if (isFound) failures['wrong-kind'].push(`${item.id} (${[...new Set(mine.map((n) => n.kind))].join('/')})`);
    let modalityOk: boolean | undefined;
    if (item.modality !== undefined && good.some((n) => NORMATIVE.has(n.kind))) {
      modalityChecked++;
      modalityOk = good.some((n) => n.modality === item.modality);
      if (modalityOk) modalityCorrect++;
      else failures['wrong-modality'].push(`${item.id} (${good.map((n) => n.modality ?? 'none').join('/')} for ${item.modality})`);
    }
    let checkboxOk: boolean | undefined;
    if (item.checkbox !== undefined && good.some((n) => NORMATIVE.has(n.kind))) {
      checkboxChecked++;
      checkboxOk = good.some((n) => n.checkbox === item.checkbox);
      if (checkboxOk) checkboxCorrect++;
      else failures['wrong-checkbox'].push(`${item.id} (${good.map((n) => n.checkbox ?? 'none').join('/')} for ${item.checkbox})`);
    }
    if (good.filter((n) => n.kind === 'capability').length > 1) failures.duplicate.push(item.id);
    outcomes.push({
      id: item.id,
      read: item.read,
      found: isFound,
      kindOk: good.length > 0,
      ...(modalityOk !== undefined ? { modalityOk } : {}),
      ...(checkboxOk !== undefined ? { checkboxOk } : {}),
      nodes: mine.map((n) => n.id),
    });
  }

  // Order: each consecutive pair of a procedure's steps must be connected by a sequence path from the earlier to the later.
  let orderPairs = 0;
  let orderKept = 0;
  const next = new Map<string, string[]>();
  for (const e of input.sequence) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const reaches = (from: readonly string[], to: ReadonlySet<string>): boolean => {
    const seen = new Set<string>();
    const queue = [...from];
    while (queue.length > 0) {
      const x = queue.shift()!;
      for (const y of next.get(x) ?? []) {
        if (to.has(y)) return true;
        if (!seen.has(y)) {
          seen.add(y);
          queue.push(y);
        }
      }
    }
    return false;
  };
  const procedures = new Map<string, LabelledItem[]>();
  for (const i of input.items)
    if (i.read === 'step' && i.procedure !== undefined) procedures.set(i.procedure, [...(procedures.get(i.procedure) ?? []), i]);
  for (const [, steps] of procedures) {
    const sorted = [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (let k = 0; k + 1 < sorted.length; k++) {
      orderPairs++;
      const a = outcomes.find((o) => o.id === sorted[k]!.id)!;
      const b = outcomes.find((o) => o.id === sorted[k + 1]!.id)!;
      const aCaps = a.nodes.filter((id) => nodes.find((n) => n.id === id)?.kind === 'capability');
      const bCaps = new Set(b.nodes.filter((id) => nodes.find((n) => n.id === id)?.kind === 'capability'));
      if (aCaps.length > 0 && bCaps.size > 0 && reaches(aCaps, bCaps)) orderKept++;
      else failures['order-lost'].push(`${sorted[k]!.id}->${sorted[k + 1]!.id}`);
    }
  }

  // Output side: every node is judged by what it matches.
  let judgedOutput = 0;
  let correctOutput = 0;
  for (const n of nodes) {
    const m = matchesOf.get(n.id)!;
    const expected = m.filter((i) => EXPECTED.has(i.read));
    const none = m.filter((i) => i.read === 'none');
    const opt = m.filter((i) => i.read === 'opt');
    const label = `${n.kind}: "${n.primary.slice(0, 70)}"`;
    if (expected.length + none.length >= 2) failures['mixed-text'].push(`${label} = ${[...expected, ...none].map((i) => i.id).join('+')}`);
    if (expected.length === 0 && none.length === 0 && opt.length > 0) continue; // neutral
    judgedOutput++;
    if (expected.some((i) => acceptable(i.read, n.kind)) && none.length === 0) correctOutput++;
    else if (expected.length === 0 && none.length > 0)
      failures['spurious-from-non-content'].push(`${label} = ${none.map((i) => i.id).join('+')}`);
    else if (m.length === 0) failures['unmatched-output'].push(label);
  }

  return {
    expected: outcomes.length,
    found,
    kindCorrect,
    modalityChecked,
    modalityCorrect,
    checkboxChecked,
    checkboxCorrect,
    orderPairs,
    orderKept,
    judgedOutput,
    correctOutput,
    failures,
    items: outcomes,
  };
}
