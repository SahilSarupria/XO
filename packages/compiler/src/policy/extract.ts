import type { PolicyEntry } from './segment.js';
import type { PolicyTable } from './from-document.js';
import {
  FactRegistry,
  MONEY_NOUNS,
  identifier,
  fmtNum,
  nameTokens,
  quote,
  singular,
  toNumber,
  upperCode,
  verbStem,
  wordsOf,
  type AssignStep,
  type FinishStep,
  type GateStep,
  type Invariant,
  type LookupTable,
  type Outcome,
  type PolicyProgram,
  type Prohibition,
  type Scope,
  type Step,
  type StepSource,
} from './program.js';

/**
 * Deterministic clause extraction: reads decision-relevant sentences out of policy prose by recognising a small set of
 * DOMAIN-NEUTRAL sentence shapes ("must be <verb>ed within N days after <event>", "if <condition>, escalate to <T>",
 * "<X> is the lesser of <A> and <B>", "$R per <unit>, up to a maximum of M <units>" …). Fact names, case kinds, the
 * amount noun and escalation targets all come from the document's own words; no vocabulary of any one industry is
 * baked in.
 *
 * Scope, stated plainly: this is shape recognition, not understanding. A sentence in another shape is not guessed at —
 * it goes to `unrecognized` for a human (or a checked model proposal, see `model-extract.ts`), and the compiled tree
 * escalates on any path that depends on it.
 */

export interface RecognizedClause {
  readonly kind: string;
  readonly rule: string;
  readonly sentence: string;
}
export interface UnrecognizedClause {
  /** position in the document; steps added from this clause keep it, so review does not reorder the policy */
  readonly order?: number;
  readonly rule: string;
  readonly section: string;
  readonly sentence: string;
}

export interface Extraction {
  readonly program: PolicyProgram;
  readonly recognized: readonly RecognizedClause[];
  readonly unrecognized: readonly UnrecognizedClause[];
  /** normative sentences seen in rule sections — the denominator of the review report */
  readonly decisionSentences: number;
}

const NORMATIVE =
  /\b(must|shall|never|only|escalat\w*|den(?:y|ied|ies)|payable|not (?:be )?(?:paid|compensable|excluded|covered)|is excluded|within|at least|more than|no (?:deductible|declared)|pays?|routed|referred|approv\w*|reimburs\w*|regardless|no matter|requires?|prohibited|forbidden|may not|cannot|do not|don't)\b|\$\d/i;

const BACKGROUND_SECTION = /\b(?:background|about|overview|introduction|glossary|handbook|appendix|contact|history|notes?)\b/i;
const TARGET = "([A-Z][A-Za-z0-9&' ]*?)";
const END_TARGET = String.raw`(?:\s*\(|\s+before\b|\s+regardless\b|\s+if\b|[,.;]|$)`;
const AUX = new Set(['was', 'were', 'is', 'are', 'be', 'been', 'being', 'am']);

const ruleTag = (e: PolicyEntry): string => /\((R\d+)\)/.exec(`${e.section} ${e.title}`)?.[1] ?? '';
const clean = (s: string): string => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const trimPhrase = (s: string): string => s.replace(/^(?:the|a|an|any|each|every)\s+/i, '').trim();
const money = (s: string): number => Number(s.replace(/,/g, ''));
const titleHead = (e: PolicyEntry): string =>
  e.title
    .replace(/\([^)]*\)/g, '')
    .split(':')[0]!
    .trim();
const reasonOf = (e: PolicyEntry, suffix = ''): string => upperCode(`${titleHead(e)}${suffix === '' ? '' : ` ${suffix}`}`) || 'RULE';

/** a boolean fact name from a clause: auxiliaries dropped ("the delay was caused by a weather event" → delay_caused_by_weather_event) */
function boolPhrase(cond: string): string {
  const cut = cond.replace(/\bat the time of\b.*$/i, '').replace(/\([^)]*\)/g, ' ');
  return nameTokens(cut, 9)
    .filter((w) => !AUX.has(w))
    .slice(0, 7)
    .join(' ');
}

interface WindowDef {
  readonly kind: string;
  readonly n: number;
  readonly unit: string;
  readonly anchor: string;
  readonly entry: PolicyEntry;
  readonly order: number;
  readonly sentence: string;
}

export function extractProgram(entries: readonly PolicyEntry[], title: string, tables: readonly PolicyTable[] = []): Extraction {
  const docText = entries.map((e) => e.text).join(' ');
  const reg = new FactRegistry(docText);
  const hasTags = entries.some((e) => ruleTag(e) !== '');
  const ruleEntries = entries.filter((e) => (hasTags ? ruleTag(e) !== '' : !BACKGROUND_SECTION.test(`${e.section} ${e.title}`)));

  const recognized: RecognizedClause[] = [];
  const unrecognized: UnrecognizedClause[] = [];
  const steps: Step[] = [];
  const prohibitions: Prohibition[] = [];
  const invariants: Invariant[] = [];
  let reviewOrder: string[] = [];
  let decisionSentences = 0;
  let seq = 0;
  const nextId = (p: string): string => `${p}${++seq}`;

  // ── pass 1: case kinds, head noun, action verb, amount noun ───────────────────────────────────────────────────
  const windows: WindowDef[] = [];
  let head = '';
  let verb = '';
  let amountNoun = '';
  const WINDOW =
    /(?:^|\b(?:A|An|The)\s+)([A-Za-z]+) ([A-Za-z]+?)s?(?: \([^)]*\))? must be (\w+) within (\d+) (days?|hours?|weeks?|months?) (?:after|of|from) (?:the )?(.+?)\.?$/i;
  let order = 0;
  for (const e of ruleEntries)
    for (const raw of e.sentences) {
      order++;
      const s = clean(raw);
      const w = WINDOW.exec(s);
      if (w !== null && toNumber(w[4]!) !== undefined) {
        if (head === '') head = singular(w[2]!.toLowerCase());
        if (verb === '') verb = verbStem(w[3]!);
        windows.push({
          kind: w[1]!.toLowerCase(),
          n: toNumber(w[4]!)!,
          unit: singular(w[5]!.toLowerCase()),
          anchor: w[6]!.toLowerCase(),
          entry: e,
          order,
          sentence: s,
        });
      }
      const t = /\b(?:the )?(?:computed |calculated |total |net |final )?([a-z]+) is more than \$[\d,]+,? escalate/i.exec(s);
      if (t !== null && amountNoun === '') amountNoun = t[1]!.toLowerCase();
    }
  const kinds = [...new Set(windows.map((w) => w.kind))];
  const kindVar = kinds.length > 0 ? identifier(`${head} type`) : undefined;
  if (kindVar !== undefined) reg.declare(`${head} type`, 'string', { forceName: kindVar, description: `kind of ${head}` });
  for (const k of kinds) if (kindVar !== undefined) reg.addEnum(kindVar, k, true);
  const moneyDoc = /\$\s?\d/.test(docText);
  const amountCalc = `${amountNoun === '' ? 'amount' : amountNoun}_calc`;
  const amountField = moneyDoc ? `${amountNoun === '' ? 'amount' : amountNoun}_usd` : undefined;

  // ── scope detection ────────────────────────────────────────────────────────────────────────────────────────────
  const kindWord = (w: string): string | undefined => {
    const x = singular(w);
    return kinds.find((k) => k === w || k === x);
  };
  const scopeIn = (text: string, adjacent: boolean): Scope | undefined => {
    if (kindVar === undefined) return undefined;
    const toks = wordsOf(text);
    const found = new Set<string>();
    if (adjacent) {
      toks.forEach((t, i) => {
        if (singular(t) !== head) return;
        for (let j = i - 1; j >= 0; j--) {
          const k = kindWord(toks[j]!);
          if (k !== undefined) found.add(k);
          else if (toks[j] === 'and' || toks[j] === 'or') continue;
          else break;
        }
      });
    } else
      for (const t of toks) {
        const k = kindWord(t);
        if (k !== undefined) found.add(k);
      }
    return found.size > 0 ? { var: kindVar, values: kinds.filter((k) => found.has(k)) } : undefined;
  };
  const scopeFor = (s: string, e: PolicyEntry): Scope | undefined =>
    scopeIn(s, true) ?? scopeIn(titleHead(e) + ' ' + (/\(([^)]*)\)/.exec(e.title)?.[1] ?? ''), false);

  // ── state shared by the shapes ─────────────────────────────────────────────────────────────────────────────────
  const quantities = new Map<string, string>(); // quantity phrase tokens → name
  const unitFacts = new Map<string, string>(); // `${kind}|${unit}` → fact name
  const ext: { kind: string; days: number; fact: string; sentence: string }[] = [];
  let pendingWith: { fact: string; expr: string; target: string; entry: PolicyEntry; s: string } | undefined;
  const finalizers: (() => void)[] = [];
  // shapes append here; they are resolved after the whole document was read
  const graceDefs: GraceDef[] = [];
  const payDefs: PayDef[] = [];
  const overrideDefs: OverrideDef[] = [];
  const finishDefs: (() => void)[] = [];
  const hitNote = (e: PolicyEntry, s: string, kind: string): void => void recognized.push({ kind, rule: ruleTag(e), sentence: s });

  const source = (e: PolicyEntry, s: string): StepSource => ({ rule: ruleTag(e), section: e.section, sentence: s });
  const gate = (
    e: PolicyEntry,
    s: string,
    sc: Scope | undefined,
    when: string,
    outcome: Outcome,
    note: string,
    at = order,
    valuation = false,
  ): GateStep => {
    const g: GateStep = {
      kind: 'gate',
      id: nextId('g'),
      order: at,
      ...(sc !== undefined ? { scope: sc } : {}),
      ...(valuation ? { valuation: true } : {}),
      when,
      outcome,
      note,
      source: source(e, s),
      origin: 'pattern',
    };
    steps.push(g);
    return g;
  };
  const assign = (
    e: PolicyEntry,
    s: string,
    sc: Scope | undefined,
    set: Record<string, string>,
    note: string,
    at = order,
    valuation = false,
  ): void => {
    // identical assignments for different kinds merge into one step scoped to the union
    const key = JSON.stringify(set);
    const i = steps.findIndex((x) => x.kind === 'assign' && JSON.stringify(x.set) === key && x.scope?.var === sc?.var);
    if (i >= 0 && sc !== undefined) {
      const old = steps[i] as AssignStep;
      steps[i] = { ...old, scope: { var: sc.var, values: kinds.filter((k) => old.scope!.values.includes(k) || sc.values.includes(k)) } };
      return;
    }
    steps.push({
      kind: 'assign',
      id: nextId('a'),
      order: at,
      ...(sc !== undefined ? { scope: sc } : {}),
      ...(valuation ? { valuation: true } : {}),
      set,
      note,
      source: source(e, s),
      origin: 'pattern',
    });
  };
  const finish = (
    e: PolicyEntry,
    s: string,
    sc: Scope | undefined,
    when: string | undefined,
    outcome: Outcome,
    amount: string | undefined,
    note: string,
  ): void => {
    const f: FinishStep = {
      kind: 'finish',
      id: nextId('f'),
      order,
      ...(sc !== undefined ? { scope: sc } : {}),
      ...(when !== undefined ? { when } : {}),
      outcome,
      ...(amount !== undefined ? { amount } : {}),
      note,
      source: source(e, s),
      origin: 'pattern',
    };
    steps.push(f);
  };
  const quantityName = (phrase: string): string | undefined => {
    const slug = identifier(phrase);
    if (quantities.has(slug)) return slug;
    for (const q of quantities.values()) if (slug.endsWith(`_${q}`) || q.endsWith(`_${slug}`)) return q;
    return undefined;
  };
  const defineQuantity = (phrase: string, fixed?: string): string => {
    const name = fixed ?? identifier(phrase);
    quantities.set(name, name);
    return name;
  };
  /** an expression operand: a quantity already defined, an existing fact, or a new numeric fact named from the phrase */
  const operand = (phrase: string, desc?: string): string => {
    const p = trimPhrase(phrase);
    const q = quantityName(p);
    if (q !== undefined) return q;
    const known = reg.find(p);
    if (known !== undefined) return known;
    return reg.declare(p, 'number', { description: desc ?? `the ${p}` });
  };
  const unitFact = (kind: string | undefined, unit: string, phrase?: string, description?: string): string => {
    const key = `${kind ?? ''}|${singular(unit)}`;
    const cur = unitFacts.get(key);
    if (cur !== undefined) return cur;
    const name = reg.declare(phrase ?? `${unit} ${kind ?? ''}`.trim(), 'number', {
      description: description ?? `number of ${singular(unit)}s${kind !== undefined ? ` (${kind} cases)` : ''}`,
    });
    unitFacts.set(key, name);
    return name;
  };
  const refersTo = (phrase: string, l: LookupTable): boolean => {
    const want = nameTokens(phrase).map(singular);
    const have = new Set([...nameTokens(l.keyPhrase), ...nameTokens(l.key)].map(singular));
    return want.length > 0 && want.every((w) => have.has(w));
  };
  const kindOfWord = (w: string): string | undefined => kinds.find((k) => k === w || k === singular(w));
  const kindOf = (sc: Scope | undefined): string | undefined => (sc !== undefined && sc.values.length === 1 ? sc.values[0] : undefined);

  // ── lookup tables: a two-column table of key → number defines a quantity for every row's key ───────────────
  const lookups: LookupTable[] = [];
  for (const t of tables) {
    if (t.header.length !== 2 || t.rows.length < 2) continue;
    const rows = t.rows.map((r) => ({
      key: (r[0] ?? '').trim().toLowerCase().replace(/\s+/g, '_'),
      value: Number((r[1] ?? '').replace(/[^0-9.\-]/g, '')),
    }));
    if (rows.some((r) => r.key === '' || Number.isNaN(r.value) || (r.value === 0 && !/\d/.test(t.rows[rows.indexOf(r)]?.[1] ?? ''))))
      continue;
    // a table keyed by the case kinds themselves is keyed by the kind input, not by a second one
    const keysAreKinds = kindVar !== undefined && rows.every((r) => kinds.includes(r.key));
    const keyFact = keysAreKinds ? kindVar! : reg.declare(t.header[0]!, 'string', { description: t.header[0]!.trim() });
    if (!keysAreKinds) for (const r of rows) reg.addEnum(keyFact, r.key, true);
    const valueName = identifier(t.header[1]!);
    if (steps.some((st) => st.kind === 'assign' && valueName in st.set)) continue;
    const dflt = rows[rows.length - 1]!;
    const expr = rows
      .slice(0, -1)
      .reduceRight((acc, r) => `${keyFact} == ${quote(r.key)} ? ${fmtNum(r.value)} : (${acc})`, fmtNum(dflt.value));
    const sentence = `${t.header.join(' | ')}: ${t.rows.map((r) => r.join(' = ')).join('; ')}`;
    steps.push({
      kind: 'assign',
      id: nextId('t'),
      order: -1,
      set: { [valueName]: expr },
      note: `lookup: ${t.header[1]} by ${t.header[0]}`,
      source: { rule: '', section: t.caption, sentence },
      origin: 'pattern',
    });
    quantities.set(valueName, valueName);
    lookups.push({ caption: t.caption, key: keyFact, keyPhrase: t.header[0]!, value: valueName, rows });
  }

  // ── pass 2: shapes, in document order ──────────────────────────────────────────────────────────────────────────
  order = 0;
  let prevHit: string | undefined;
  for (const e of ruleEntries) {
    for (const raw of e.sentences) {
      order++;
      const s = clean(raw);
      const sc = scopeFor(s, e);
      const kind = kindOf(sc);
      let hit: string | undefined;
      let x: RegExpExecArray | null;
      const m = (re: RegExp): RegExpExecArray | null => re.exec(s);

      if (windows.some((w) => w.sentence === s)) {
        hit = 'window';
      } else if (
        (x = m(
          /^(?:If|When) (.+?), the (?:[a-z]+ )?(?:window|deadline)(?: for that [a-z]+ [a-z]+)? is extended to (\d+) (days?|hours?) (?:after|of|from)\b/i,
        ))
      ) {
        const fact = reg.declare(boolPhrase(x[1]!), 'boolean', { description: `true if ${trimPhrase(x[1]!)}` });
        const k = kind ?? kinds.find((kk) => new RegExp(`\\b${kk}\\b`, 'i').test(s));
        if (k !== undefined) ext.push({ kind: k, days: Number(x[2]), fact, sentence: s });
        hit = k !== undefined ? 'window_extension' : undefined;
      } else if (
        (x = m(
          new RegExp(
            String.raw`\b(?:whose|where|with|having) ([a-z][a-z ]*?) is (\w+)\b[^.;]*?\b(?:is|are|must be) (?:escalated|routed|referred|sent|forwarded) to (?:the )?${TARGET}${END_TARGET}`,
          ),
        ))
      ) {
        const attr = reg.declare(x[1]!, 'string', { enumValue: x[2]!.toLowerCase(), description: trimPhrase(x[1]!) });
        gate(
          e,
          s,
          sc,
          `${attr} == ${quote(x[2]!.toLowerCase())}`,
          { decision: 'escalate', target: x[3]!.trim(), reason: reasonOf(e) },
          `${trimPhrase(x[1]!)} is ${x[2]}`,
        );
        hit = 'gate';
      } else if (
        (x = m(
          new RegExp(
            String.raw`(?:the )?(\w+) (?:has|have) \w+ (\d+) or more (?:earlier |prior |previous )?(\w+) in the (?:previous|last|past) (\d+) days[^.]*?escalate (?:the \w+ )?to (?:the )?${TARGET}${END_TARGET}`,
            'i',
          ),
        ))
      ) {
        const fact = reg.declare(`${x[1]} ${x[3]} last ${x[4]}d`, 'number', {
          forceName: `${x[1]!.toLowerCase()}_${x[3]!.toLowerCase()}_last_${x[4]}d`,
          description: `number of ${x[3]} by this ${x[1]} in the previous ${x[4]} days (0 if none)`,
        });
        gate(
          e,
          s,
          sc,
          `${fact} >= ${x[2]}`,
          { decision: 'escalate', target: x[5]!.trim(), reason: reasonOf(e) },
          `${x[2]} or more ${x[3]} in ${x[4]} days`,
        );
        hit = 'gate';
      } else if (
        (x = m(
          new RegExp(
            String.raw`^(?:(?:Any|An?|The)\s+)?([^,;]+?) (?:is|are|must be|shall be) (?:escalated|routed|referred|sent|forwarded) to (?:the )?${TARGET}${END_TARGET}`,
          ),
        ))
      ) {
        const fact = reg.declare(boolPhrase(x[1]!), 'boolean', { description: `true if ${trimPhrase(x[1]!)}` });
        gate(e, s, sc, `${fact} == true`, { decision: 'escalate', target: x[2]!.trim(), reason: reasonOf(e) }, trimPhrase(x[1]!));
        hit = 'gate';
      } else if ((x = m(/^(?:An?|The) (?:[a-z]+ ){1,2}(?:is|are) (?:denied|excluded|not covered|not payable) (?:when|if) (.+?)\.?$/i))) {
        const fact = reg.declare(boolPhrase(x[1]!), 'boolean', { description: `true if ${trimPhrase(x[1]!)}` });
        gate(e, s, sc, `${fact} == true`, { decision: 'deny', reason: reasonOf(e) }, trimPhrase(x[1]!));
        hit = 'gate';
      } else if (
        (x = m(
          /is only (?:payable|valid|eligible|covered|approved) (?:when|if) (?:the )?([a-z ]+?) (?:was|were|is|are) at least (\d+) (days?|hours?) (\w+)/i,
        ))
      ) {
        const f = unitFact(kind, x[3]!, `${singular(x[3]!)}s ${x[4]}`, `number of ${x[3]} the ${x[1]} was ${x[4]} (0 if not ${x[4]})`);
        gate(e, s, sc, `${f} < ${x[2]}`, { decision: 'deny', reason: reasonOf(e) }, `fewer than ${x[2]} ${x[3]} ${x[4]}`);
        hit = 'gate';
      } else if ((x = m(/^(?:When|If) (.+?), the first (\d+) (days?|hours?) of (?:the )?(\w+) (?:are|is) not compensable/i))) {
        const fact = reg.declare(boolPhrase(x[1]!), 'boolean', { description: `true if ${trimPhrase(x[1]!)}` });
        const unit = singular(x[3]!);
        graceDefs.push({ kind, unit, fact, n: Number(x[2]), order, e, s });
        hit = 'grace';
      } else if ((x = m(/^An? ([a-z]+) ([a-z]+) of (\d+) (days?|hours?) or less is denied/i)) && reg.find(x[1]!) !== undefined) {
        const q = reg.find(x[1]!)!;
        const f = unitFact(kind ?? kindOfWord(x[2]!), x[4]!);
        gate(
          e,
          s,
          sc,
          `${q} == true && ${f} <= ${x[3]}`,
          { decision: 'deny', reason: reasonOf(e) },
          `${x[1]} ${x[2]} of ${x[3]} ${x[4]} or less`,
        );
        hit = 'gate';
      } else if ((x = m(/^An? ([a-z]+) of less than (\d+) (days?|hours?) is denied/i))) {
        if (steps.some((g) => g.kind === 'gate' && new RegExp(`\\b${x![2]}\\b`).test(g.when) && g.outcome.decision === 'deny'))
          hit = 'restates';
        else {
          const f = unitFact(kind ?? kindOfWord(x[1]!), x[3]!);
          gate(e, s, sc, `${f} < ${x[2]}`, { decision: 'deny', reason: reasonOf(e) }, `${x[1]} of less than ${x[2]} ${x[3]}`);
          hit = 'gate';
        }
      } else if ((x = m(/(?:are |is )?paid at \$([\d,.]+) per (?:compensable )?(\w+),? up to a maximum of (\d+) (\w+)/i))) {
        payDefs.push({ kind, perUnit: money(x[1]!), unit: singular(x[2]!), max: Number(x[3]), order, e, s });
        hit = 'rate';
      } else if (/\bno [a-z ,-]+ (?:logic )?(?:apply|applies) to [a-z]+ (?:claims|cases|requests|reports)\b/i.test(s)) {
        hit = 'scope_exclusion';
      } else if ((x = m(/only payable for (\w+) \w+; for any other ([a-z ]+?) the \w+ is denied/i))) {
        const attr = reg.declare(x[2]!, 'string', { enumValue: x[1]!.toLowerCase(), description: trimPhrase(x[2]!) });
        gate(
          e,
          s,
          sc,
          `${attr} != ${quote(x[1]!.toLowerCase())}`,
          { decision: 'deny', reason: `NOT_${upperCode(x[1]!)}` },
          `${x[2]} is not ${x[1]}`,
        );
        hit = 'gate';
      } else if (
        (x = m(
          new RegExp(
            String.raw`^The ([a-z ]+?) must be available\b[^;]*;\s*if no \w+ is available, escalate to (?:the )?${TARGET}${END_TARGET}`,
            'i',
          ),
        ))
      ) {
        const fact = reg.declare(`${x[1]} available`, 'boolean', { description: `true if the ${trimPhrase(x[1]!)} is available` });
        gate(
          e,
          s,
          sc,
          `${fact} == false`,
          { decision: 'escalate', target: x[2]!.trim(), reason: `MISSING_${upperCode(x[1]!)}` },
          `no ${trimPhrase(x[1]!)}`,
        );
        hit = 'gate';
      } else if ((x = m(/^An? ([a-z]+) of (\d+) (days?|hours?) or less((?: [a-z]+)*?) (?:is|are)\b[^.]*?denied/i))) {
        const f = reg.declare(`${x[1]} ${x[3]}`, 'number', { description: `${x[3]} of ${x[1]}${x[4]}` });
        gate(e, s, sc, `${f} <= ${x[2]}`, { decision: 'deny', reason: 'WITHIN_TOLERANCE' }, `${x[1]} of ${x[2]} ${x[3]} or less`);
        hit = 'gate';
      } else if ((x = m(/(?:more than|over|above|exceeds?) (\d+) (?:days?|hours?) is paid as a total loss(?: \((\d+)% (\w+)\))?/i))) {
        if (x[2] !== undefined) overrideDefs.push({ scope: sc, pct: Number(x[2]), noun: x[3]!, e, s, order });
        hit = 'total';
      } else if ((x = m(/^(?:The |A |An )?([a-z ]+?) is the ([a-z ]+?)(?: in (\w+))? multiplied by the rate for the ([a-z ]+?): (.+)$/i))) {
        const rates = [...x[5]!.matchAll(/(?:^|[:,]\s*|\band\s+)([a-z][a-z ]*?) \$([\d.]+) per (\w+)/g)].map((r) => ({
          cls: r[1]!.trim().replace(/\s+/g, '_'),
          perUnit: money(r[2]!),
          unit: r[3]!,
        }));
        if (rates.length > 0) {
          const klass = reg.declare(x[4]!, 'string', { description: trimPhrase(x[4]!) });
          for (const r of rates) reg.addEnum(klass, r.cls, true);
          const base = operand(
            `${x[2]}${x[3] !== undefined ? ` in ${x[3]}` : ''}`,
            `${trimPhrase(x[2]!)}${x[3] !== undefined ? ` in ${x[3]}` : ''}`,
          );
          const rateName = identifier(`rate per ${rates[0]!.unit}`);
          const dflt = rates.find((r) => r.cls === 'general') ?? rates[0]!;
          const expr = rates
            .filter((r) => r !== dflt)
            .reduceRight((acc, r) => `${klass} == ${quote(r.cls)} ? ${fmtNum(r.perUnit)} : (${acc})`, fmtNum(dflt.perUnit));
          const target = defineQuantity(x[1]!);
          assign(
            e,
            s,
            sc,
            { [rateName]: expr, [target]: `${base} * ${rateName}` },
            `${trimPhrase(x[1]!)} = ${trimPhrase(x[2]!)} × rate for ${x[4]}`,
          );
          hit = 'rates';
        }
      } else if (
        lookups.length > 0 &&
        (x = m(
          /^(?:The |A |An )?([a-z ]+?) is the ([a-z ]+?)(?: in (\w+))? multiplied by the [a-z ]+? (?:for|by|of) the ([a-z ]+?)\.?$/i,
        )) &&
        lookups.some((l) => refersTo(x![4]!, l))
      ) {
        const lk = lookups.find((l) => refersTo(x![4]!, l))!;
        const base = operand(
          `${x[2]}${x[3] !== undefined ? ` in ${x[3]}` : ''}`,
          `${trimPhrase(x[2]!)}${x[3] !== undefined ? ` in ${x[3]}` : ''}`,
        );
        const target = defineQuantity(x[1]!);
        assign(e, s, sc, { [target]: `${base} * ${lk.value}` }, `${trimPhrase(x[1]!)} = ${trimPhrase(x[2]!)} × ${lk.value}`);
        hit = 'rates';
      } else if ((x = m(/^With (?:an? )?(.+?) on the [^,]+, the ([a-z ]+?) is the ([a-z ]+?)\.?$/i))) {
        const cond = reg.declare(x[1]!, 'boolean', { description: `true if the case has ${trimPhrase(x[1]!)}` });
        pendingWith = { fact: cond, expr: operand(x[3]!), target: x[2]!, entry: e, s };
        hit = 'definition';
      } else if (
        (x = m(
          /^Without it, the ([a-z ]+?) is the lesser of the ([a-z ]+?) and the ([a-z ]+?)(?:;\s*if no ([a-z ]+?) was declared, the [a-z ]+? is the ([a-z ]+?))?\.?$/i,
        )) &&
        pendingWith !== undefined &&
        identifier(pendingWith.target) === identifier(x[1]!)
      ) {
        const a = operand(x[2]!);
        if (x[4] !== undefined) reg.setDescription(operand(x[2]!), `the ${trimPhrase(x[2]!)} in USD; 0 if no value was declared`);
        const b = operand(x[3]!);
        const target = defineQuantity(x[1]!);
        const fallback = x[5] !== undefined ? `${a} > 0 ? min(${a}, ${b}) : ${operand(x[5])}` : `min(${a}, ${b})`;
        assign(e, s, undefined, { [target]: `${pendingWith.fact} == true ? ${pendingWith.expr} : (${fallback})` }, `${trimPhrase(x[1]!)}`);
        pendingWith = undefined;
        hit = 'definition';
      } else if (
        (x = m(
          /^For an? \w+ \w+, the ([a-z ]+?) is the ([a-z ]+?) multiplied by the ([a-z ]+?) percentage, minus any ([a-z ]+?)(?:;\s*if nothing remains the \w+ is denied as having no net loss)?\.?$/i,
        ))
      ) {
        const pct = reg.declare(`${x[3]} percentage`, 'number', {
          description: `percent of the affected goods that are ${x[3]}d (0–100)`.replace(/ed d\b/, 'ed'),
        });
        const sal = operand(x[4]!, `${trimPhrase(x[4]!)}; 0 if none`);
        const base = operand(x[2]!);
        const target = defineQuantity(/no net loss/i.test(s) ? 'net loss' : x[1]!);
        assign(e, s, sc, { [target]: `${base} * ${pct} / 100 - ${sal}` }, `net amount after ${trimPhrase(x[4]!)}`, order, true);
        if (/if nothing remains/i.test(s))
          gate(e, s, sc, `${target} <= 0`, { decision: 'deny', reason: 'NO_NET_LOSS' }, 'nothing remains after adjustments', order, true);
        hit = 'formula';
      } else if ((x = m(/^([A-Z][a-z]+) and ([a-z]+) (?:claims|cases|requests|reports) are treated as (\d+)% (\w+)(?: with no (\w+))?/i))) {
        overrideDefs.push({ scope: sc, pct: Number(x[3]), noun: x[4]!, zero: x[5], e, s, order });
        hit = 'override';
      } else if (
        (x = m(
          /deductible of \$([\d,.]+) per \w+ is subtracted from the ([a-z ]+?) unless the \w+ has (?:an? )?([A-Za-z ]+?)(?: endorsement)?, in which case there is no deductible/i,
        ))
      ) {
        const cov = reg.find(x[3]!) ?? reg.declare(x[3]!, 'boolean', { description: `true if the case has ${x[3]}` });
        const net = operand(x[2]!);
        quantities.set(amountCalc, amountCalc);
        assign(
          e,
          s,
          undefined,
          { deductible: `${cov} == true ? 0 : ${fmtNum(money(x[1]!))}`, [amountCalc]: `${net} - deductible` },
          'deduct the fixed amount unless waived',
        );
        hit = 'deductible';
      } else if ((x = m(/^If the ([a-z ]+?) does not exceed the deductible the \w+ is denied/i))) {
        gate(e, s, sc, `${amountCalc} <= 0`, { decision: 'deny', reason: 'BELOW_DEDUCTIBLE' }, 'net amount does not exceed the deductible');
        hit = 'gate';
      } else if (
        (x = m(/^An? (\w+) \w+ with less than (\d+)% (\w+) that is paid is an? ([a-z]+) [a-z]+; all other paid \w+ are ([a-z]+)/i))
      ) {
        const pct =
          reg.find(`${x[3]} percentage`) ?? reg.declare(`${x[3]} percentage`, 'number', { description: `percent that is ${x[3]} (0–100)` });
        const amt = amountField !== undefined ? `=round(${amountCalc}, 2)` : undefined;
        const decide = (w: string): string => (/^approv/.test(w) ? 'approve' : w);
        const scopeOnly = scopeIn(x[1]!, false) ?? { var: kindVar ?? 'case_type', values: [x[1]!.toLowerCase()] };
        finishDefs.push(() => {
          finish(e, s, scopeOnly, `${pct} < ${x![2]}`, { decision: decide(x![4]!), reason: upperCode(x![4]!) }, amt, `${x![4]} settlement`);
          finish(e, s, undefined, undefined, { decision: decide(x![5]!), reason: 'PAID' }, amt, 'all other paid cases');
        });
        hit = 'finish';
      } else if (
        (x = m(
          new RegExp(
            String.raw`(?:If|When) the (?:computed |calculated |total |net |final )?(\w+) is more than \$([\d,]+),? escalate to (?:the )?${TARGET}${END_TARGET}`,
            'i',
          ),
        ))
      ) {
        quantities.set(amountCalc, amountCalc);
        const limit = money(x[2]!);
        const target = x[3]!.trim();
        gate(
          e,
          s,
          sc,
          `${amountCalc} > ${fmtNum(limit)}`,
          { decision: 'escalate', target, reason: reasonOf(e) },
          `${x[1]} above ${fmtNum(limit)}`,
        );
        if (/never approves? more than/i.test(s)) invariants.push({ kind: 'authority_limit', limit, target, sentence: s });
        hit = 'threshold';
      } else if (
        (x = m(
          new RegExp(
            String.raw`^(?:(?:Any|An?|The)\s+)?(.+?) (?:worth )?(?:above|over|more than|exceeding) \$([\d,]+),? (?:needs?|requires?) (?:approval (?:from|by) )?(?:the )?${TARGET}(?: approval)?${END_TARGET}`,
          ),
        ))
      ) {
        // "<thing> above $N needs <T> approval" — an authority limit on that thing's amount
        const limit = money(x[2]!);
        const target = x[3]!.trim();
        const subject = x[1]!.split(/\s+(?:to|worth|of|for)\s+/)[0]!;
        const head = singular(wordsOf(subject).slice(-1)[0] ?? 'amount');
        const amountLike = MONEY_NOUNS.has(head) || head === amountNoun;
        let quantity = amountCalc;
        if (amountLike) quantities.set(amountCalc, amountCalc);
        else
          quantity = reg.declare(`${subject} amount`, 'number', {
            forceName: `${identifier(subject, 3)}_usd`,
            description: `value of the ${trimPhrase(subject)} in USD`,
          });
        gate(
          e,
          s,
          sc,
          `${quantity} > ${fmtNum(limit)}`,
          { decision: 'escalate', target, reason: reasonOf(e) },
          `${subject} above ${fmtNum(limit)}`,
        );
        hit = 'threshold';
      } else if (
        (x = m(
          /^(?:(?:Any|An?|The)\s+)?(.+?) over \$([\d,]+) is only (?:reimbursable|payable|covered|approved|eligible) if (?:an? |the )?(.+?) is (attached|filed|provided|submitted|included|recorded)\b/i,
        ))
      ) {
        // "<thing> over $N is only <payable> if <Y> is attached" — over the floor, deny unless the evidence is present
        const floor = money(x[2]!);
        const subject = x[1]!;
        const amountFact = reg.declare(`${subject} amount`, 'number', {
          forceName: `${identifier(subject, 3)}_usd`,
          description: `value of the ${trimPhrase(subject)} in USD`,
        });
        const ev = reg.declare(`${x[3]} ${x[4]}`, 'boolean', {
          forceName: `${identifier(x[3]!, 3)}_${x[4]!.toLowerCase()}`,
          description: `true if ${trimPhrase(x[3]!)} is ${x[4]!.toLowerCase()}`,
        });
        gate(
          e,
          s,
          sc,
          `${amountFact} > ${fmtNum(floor)} && ${ev} == false`,
          { decision: 'deny', reason: reasonOf(e) },
          `${subject} over ${fmtNum(floor)} without ${trimPhrase(x[3]!)}`,
        );
        hit = 'evidence_required';
      } else if (
        (x = m(/^If there is no (.+?), the [a-z ]+ (?:is|are) (?:rejected|denied|declined)\.?$/i)) &&
        prevHit === 'evidence_required'
      ) {
        hit = 'restates_previous';
      } else if (
        (x = m(
          /^(?:(?:Any|An?|The)\s+)?([A-Za-z][A-Za-z ]*?) (?:is|are) never (?:reimbursable|reimbursed|payable|covered|approved|eligible)\.?$/i,
        ))
      ) {
        const fact = reg.declare(`${x[1]} present`, 'boolean', {
          forceName: identifier(x[1]!, 3),
          description: `true if the case involves ${trimPhrase(x[1]!)}`,
        });
        gate(e, s, sc, `${fact} == true`, { decision: 'deny', reason: reasonOf(e) }, `${trimPhrase(x[1]!)} is never allowed`);
        hit = 'never_allowed';
      } else if (/(?:escalated|denied)(?: or (?:escalated|denied))? \w+ (?:are|is) not paid\b/i.test(s)) {
        invariants.push({ kind: 'zero_amount_on', decisions: ['deny', 'escalate'], sentence: s });
        hit = 'invariant';
      } else if (/^review every \w+ in this order/i.test(s)) {
        reviewOrder = [...s.matchAll(/\(\d+\)\s*([^,()]+?)(?=,|\.|$)/g)].map((r) => r[1]!.trim().replace(/^and\s+/, ''));
        hit = 'order';
      } else if (
        (x = m(/^(?:Do not|Don't|Never|You must not|Staff must not) (.+?)\.?$/i)) ||
        (x = m(/\b(?:never|must not|may not|shall not) ((?:pay|deny|promise|tell|disclose|share|approve|create|issue|release)\b.*?)\.?$/i))
      ) {
        prohibitions.push({ text: x[1]!.trim(), sentence: s, rule: ruleTag(e) });
        hit = 'prohibition';
      } else if (/\bis never excluded\b/i.test(s)) {
        hit = 'carve_out';
      } else if (
        /(?:earlier rule|later rule|an earlier|this check comes last|filed after its window is denied as late|never pays or denies|applies even if)/i.test(
          s,
        )
      ) {
        hit = 'explanatory';
      }

      if (hit !== undefined) hitNote(e, s, hit);
      prevHit = hit;
      if (NORMATIVE.test(s) || /\d/.test(s) || hit !== undefined) {
        decisionSentences++;
        if (hit === undefined) unrecognized.push({ order, rule: ruleTag(e), section: e.section, sentence: s });
      }
    }
  }

  // ── deferred pieces that need every sentence read first ───────────────────────────────────────────────────────
  // filing window: one derived day-count fact, a per-kind limit, one gate
  if (windows.length > 0) {
    const first = windows[0]!;
    const unit = first.unit;
    const verbName = verb === '' ? 'file' : verb;
    const daysFact = reg.declare(`${unit}s to ${verbName}`, 'number', {
      forceName: `${unit}s_to_${verbName}`,
      derivable: true,
      description: `calendar ${unit}s from the starting event to the ${verbName} date. The starting event: ${windows.map((w) => `${w.kind}: ${w.anchor}`).join('; ')}`,
    });
    const own = windows.map((w) => {
      const extn = ext.find((q) => q.kind === w.kind);
      return { kind: w.kind, expr: extn !== undefined ? `(${extn.fact} == true ? ${extn.days} : ${w.n})` : fmtNum(w.n) };
    });
    const last = own[own.length - 1]!;
    const expr =
      kindVar === undefined || own.length === 1
        ? last.expr
        : own.slice(0, -1).reduceRight((acc, o) => `${kindVar} == ${quote(o.kind)} ? ${o.expr} : (${acc})`, last.expr);
    const e0 = first.entry;
    const limitName = 'window_limit';
    assign(e0, first.sentence, undefined, { [limitName]: expr }, `time limit per case kind`, first.order);
    gate(
      e0,
      first.sentence,
      undefined,
      `${daysFact} > ${limitName}`,
      { decision: 'deny', reason: reasonOf(e0) },
      'filed after the time limit',
      first.order,
    );
  }

  // time units of a "first N units are not compensable" clause, and the per-unit payment that uses them
  for (const p of payDefs) {
    const units = unitFact(p.kind, p.unit);
    const grace = graceDefs.find((g) => g.kind === p.kind && g.unit === p.unit);
    const graceName = grace !== undefined ? 'grace_units' : undefined;
    if (grace !== undefined)
      assign(
        grace.e,
        grace.s,
        grace.kind !== undefined ? { var: kindVar!, values: [grace.kind] } : undefined,
        { grace_units: `${grace.fact} == true ? ${grace.n} : 0` },
        'excluded leading units',
        grace.order,
      );
    const sc2: Scope | undefined = p.kind !== undefined && kindVar !== undefined ? { var: kindVar, values: [p.kind] } : undefined;
    quantities.set(amountCalc, amountCalc);
    assign(
      p.e,
      p.s,
      sc2,
      {
        [`compensable_${p.unit}s`]: `min(${units}${graceName !== undefined ? ` - ${graceName}` : ''}, ${p.max})`,
        [amountCalc]: `${fmtNum(p.perUnit)} * compensable_${p.unit}s`,
      },
      `${fmtNum(p.perUnit)} per ${p.unit}, at most ${p.max}`,
      p.order,
    );
  }

  // "treated as N% X with no Y" → override the facts for those kinds
  for (const o of overrideDefs) {
    const set: Record<string, string> = {};
    const pct = reg.find(`${o.noun} percentage`) ?? reg.find(o.noun);
    if (pct !== undefined) set[pct] = fmtNum(o.pct);
    if (o.zero !== undefined) {
      const z = reg.find(o.zero);
      if (z !== undefined) set[z] = '0';
    }
    if (Object.keys(set).length > 0) assign(o.e, o.s, o.scope, set, `treated as ${o.pct}% ${o.noun}`, o.order);
    // "treated as 100% damage": those kinds are valued the way the named kind is
    const as = kindOfWord(o.noun);
    if (as !== undefined && o.scope !== undefined)
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]!;
        if (st.valuation === true && st.scope !== undefined && st.scope.values.includes(as))
          steps[i] = {
            ...st,
            scope: { var: st.scope.var, values: kinds.filter((k) => st.scope!.values.includes(k) || o.scope!.values.includes(k)) },
          } as Step;
      }
  }
  for (const f of finishDefs) f();
  for (const f of finalizers) f();

  // a threshold on an amount the document never calculates reads the amount as a plain input of the case
  const calcDefined = steps.some((st) => st.kind === 'assign' && amountCalc in st.set);
  const mentionsCalc = steps.some((st) =>
    new RegExp(`\\b${amountCalc}\\b`).test(
      st.kind === 'gate' ? st.when : st.kind === 'finish' ? `${st.when ?? ''} ${st.amount ?? ''}` : '',
    ),
  );
  if (!calcDefined && mentionsCalc) {
    const noun = amountNoun === '' ? 'amount' : amountNoun;
    const fact = reg.declare(`total ${noun}`, 'number', { description: `the total ${noun} of the case in USD` });
    const sub = (t: string): string => t.replace(new RegExp(`\\b${amountCalc}\\b`, 'g'), fact);
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]!;
      if (st.kind === 'gate') steps[i] = { ...st, when: sub(st.when) };
      else if (st.kind === 'finish')
        steps[i] = {
          ...st,
          ...(st.when !== undefined ? { when: sub(st.when) } : {}),
          ...(st.amount !== undefined ? { amount: sub(st.amount) } : {}),
        };
    }
  }

  const standIn = !calcDefined && mentionsCalc ? `total_${amountNoun === '' ? 'amount' : amountNoun}` : undefined;
  const facts = reg
    .list()
    .map((f) => (standIn !== undefined && f.name.startsWith(standIn) && f.type === 'number' ? { ...f, standsForAmount: true } : f));
  const program: PolicyProgram = {
    title,
    facts,
    steps: [...steps].sort((a, b) => a.order - b.order),
    ...(kindVar !== undefined ? { kindVar } : {}),
    kinds,
    ...(amountField !== undefined ? { amountField } : {}),
    invariants,
    prohibitions,
    reviewOrder,
    ...(lookups.length > 0 ? { tables: lookups } : {}),
  };
  return { program, recognized, unrecognized, decisionSentences };
}

interface GraceDef {
  kind: string | undefined;
  unit: string;
  fact: string;
  n: number;
  order: number;
  e: PolicyEntry;
  s: string;
}
interface PayDef {
  kind: string | undefined;
  perUnit: number;
  unit: string;
  max: number;
  order: number;
  e: PolicyEntry;
  s: string;
}
interface OverrideDef {
  scope: Scope | undefined;
  pct: number;
  noun: string;
  zero?: string | undefined;
  e: PolicyEntry;
  s: string;
  order: number;
}
