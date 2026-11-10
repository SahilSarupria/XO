import { FORBIDDEN_KEYS, isAuthorityField, type ProcedureFinding, type ProcedureErrorCode } from './codes.js';
import type { ProcedureDefinition } from './definition.js';

type Obj = Record<string, unknown>;
const enc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Identifier PATTERN only (not a length bound, per O-5). */
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy', 'falsy']);
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const UNSUPPORTED_KINDS = new Set(['loop', 'parallel', 'merge', 'delay', 'subworkflow', 'sequence', 'start', 'end']);
const AI_KINDS = new Set(['model', 'ai_provider', 'hybrid', 'ai']);

/** Own-property read; never walks the prototype chain. */
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

class Ctx {
  readonly findings: ProcedureFinding[] = [];
  add(code: ProcedureErrorCode, path: string): void {
    this.findings.push({ code, path });
  }
  /** Reject unknown / authority / forbidden keys; returns nothing. */
  fields(o: Obj, allowed: readonly string[], path: string): void {
    for (const k of Object.keys(o)) {
      const p = `${path}/${enc(k)}`;
      if (FORBIDDEN_KEYS.has(k)) this.add('PROC_FORBIDDEN_KEY', p);
      else if (allowed.includes(k))
        continue; // explicitly allowed names win over the authority-prefix match (e.g. inputBindings[].bindingStatus)
      else if (isAuthorityField(k)) this.add('PROC_AUTHORITY_FIELD', p);
      else this.add('PROC_UNKNOWN_FIELD', p);
    }
  }
  str(o: Obj, k: string, path: string, required: boolean): string | undefined {
    const v = own(o, k);
    if (v === undefined) {
      if (required) this.add('PROC_MISSING_FIELD', `${path}/${k}`);
      return undefined;
    }
    if (typeof v !== 'string' || v.length === 0) {
      this.add('PROC_INVALID_FIELD', `${path}/${k}`);
      return undefined;
    }
    return v;
  }
  id(o: Obj, k: string, path: string, required: boolean): string | undefined {
    const v = this.str(o, k, path, required);
    if (v === undefined) return undefined;
    if (!ID.test(v) || FORBIDDEN_KEYS.has(v)) {
      this.add('PROC_INVALID_FIELD', `${path}/${k}`);
      return undefined;
    }
    return v;
  }
}

/**
 * Value-path grammar: `input.<seg>(.<seg>)*` or `steps.<stepId>.output.<seg>(.<seg>)*`.
 * Segments `__proto__`, `constructor`, `prototype` are rejected HERE, at the
 * procedure-validator boundary. This is a boundary mitigation ONLY: the runtime
 * helper `resolvePath` (workflow-condition.ts) still walks `current[segment]`
 * with no own-property check, so runtime-wide hardening remains outstanding and
 * separately owner-gated.
 */
function checkPath(path: unknown, at: string, stepIds: ReadonlySet<string>, c: Ctx): string[] | null {
  if (typeof path !== 'string' || path.length === 0) {
    c.add('PROC_INVALID_PATH', at);
    return null;
  }
  const segs = path.split('.');
  let bad = false;
  for (const s of segs) {
    if (FORBIDDEN_KEYS.has(s)) {
      c.add('PROC_FORBIDDEN_KEY', at);
      bad = true;
      break;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(s)) {
      c.add('PROC_INVALID_PATH', at);
      bad = true;
      break;
    }
  }
  if (bad) return null;
  if (segs[0] === 'input') {
    if (segs.length < 2) {
      c.add('PROC_INVALID_PATH', at);
      return null;
    }
    return segs;
  }
  if (segs[0] === 'steps') {
    if (segs.length < 4 || segs[2] !== 'output') {
      c.add('PROC_INVALID_PATH', at);
      return null;
    }
    if (!stepIds.has(segs[1] as string)) {
      c.add('PROC_DANGLING_REFERENCE', at);
      return null;
    }
    return segs;
  }
  c.add('PROC_INVALID_PATH', at);
  return null;
}

function checkCondition(v: unknown, at: string, stepIds: ReadonlySet<string>, c: Ctx): void {
  if (!isObj(v)) {
    c.add('PROC_INVALID_CONDITION', at);
    return;
  }
  c.fields(v, ['path', 'op', 'value'], at);
  checkPath(own(v, 'path'), `${at}/path`, stepIds, c);
  const op = own(v, 'op');
  if (typeof op !== 'string' || !OPS.has(op)) {
    c.add('PROC_INVALID_CONDITION', `${at}/op`);
    return;
  }
  const hasValue = Object.prototype.hasOwnProperty.call(v, 'value');
  if (NUMERIC_OPS.has(op) && typeof own(v, 'value') !== 'number') c.add('PROC_INVALID_CONDITION', `${at}/value`);
  if (['eq', 'neq'].includes(op) && !hasValue) c.add('PROC_INVALID_CONDITION', `${at}/value`);
  if (['exists', 'truthy', 'falsy'].includes(op) && hasValue) c.add('PROC_INVALID_CONDITION', `${at}/value`);
}

export interface StaticResult {
  readonly findings: readonly ProcedureFinding[];
  readonly definition?: ProcedureDefinition;
}

/** Locally verifiable validation only: shape, allowlists, reference integrity, graph analysis. No registry access. */
export function validateStructure(doc: unknown): StaticResult {
  const c = new Ctx();
  if (!isObj(doc)) return { findings: [{ code: 'PROC_NOT_AN_OBJECT', path: '' }] };
  c.fields(doc, ['schema', 'procedureId', 'version', 'title', 'compilationRef', 'derivedFrom', 'when', 'steps', 'then', 'unknowns'], '');

  const schema = own(doc, 'schema');
  if (schema === undefined) c.add('PROC_MISSING_FIELD', '/schema');
  else if (schema !== 'xo.procedure/1') c.add('PROC_UNSUPPORTED_SCHEMA', '/schema');
  c.id(doc, 'procedureId', '', true);
  const version = own(doc, 'version');
  if (version === undefined) c.add('PROC_MISSING_FIELD', '/version');
  else if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) c.add('PROC_INVALID_FIELD', '/version');
  if (own(doc, 'title') !== undefined) c.str(doc, 'title', '', false);

  const cref = own(doc, 'compilationRef');
  if (cref !== undefined) {
    if (!isObj(cref)) c.add('PROC_INVALID_FIELD', '/compilationRef');
    else {
      c.fields(cref, ['compilationId', 'graphHash'], '/compilationRef');
      c.str(cref, 'compilationId', '/compilationRef', true);
      const gh = c.str(cref, 'graphHash', '/compilationRef', true);
      if (gh !== undefined && !/^sha256:[0-9a-f]{64}$/.test(gh)) c.add('PROC_INVALID_FIELD', '/compilationRef/graphHash');
    }
  }
  const df = own(doc, 'derivedFrom');
  if (df !== undefined) {
    if (!isObj(df)) c.add('PROC_INVALID_FIELD', '/derivedFrom');
    else {
      c.fields(df, ['candidateWorkflowId'], '/derivedFrom');
      c.str(df, 'candidateWorkflowId', '/derivedFrom', true);
    }
  }
  const unknowns = own(doc, 'unknowns');
  if (unknowns !== undefined) {
    if (!Array.isArray(unknowns) || unknowns.some((u) => typeof u !== 'string')) c.add('PROC_INVALID_FIELD', '/unknowns');
  }

  const steps = own(doc, 'steps');
  if (steps === undefined) {
    c.add('PROC_MISSING_FIELD', '/steps');
    return { findings: c.findings };
  }
  if (!Array.isArray(steps)) {
    c.add('PROC_INVALID_FIELD', '/steps');
    return { findings: c.findings };
  }
  if (steps.length === 0) c.add('PROC_EMPTY', '/steps');

  // Pass 1: collect ids (reference integrity needs the full set up front).
  const ids = new Set<string>();
  steps.forEach((s, idx) => {
    if (!isObj(s)) return;
    const id = own(s, 'id');
    if (typeof id === 'string' && ID.test(id) && !FORBIDDEN_KEYS.has(id)) {
      if (ids.has(id)) c.add('PROC_DUPLICATE_ID', `/steps/${idx}/id`);
      ids.add(id);
    }
  });
  const kindOf = new Map<string, string>();

  // Pass 2: per-step shape.
  const edges = new Map<string, string[]>();
  const bindingEdges: { consumer: string; producer: string; at: string }[] = [];
  const stepRefs: { producer: string; at: string }[] = [];
  steps.forEach((s, idx) => {
    const at = `/steps/${idx}`;
    if (!isObj(s)) {
      c.add('PROC_INVALID_FIELD', at);
      return;
    }
    const id = c.id(s, 'id', at, true);
    const kind = own(s, 'kind');
    if (kind === undefined) {
      c.add('PROC_MISSING_FIELD', `${at}/kind`);
      return;
    }
    if (typeof kind !== 'string') {
      c.add('PROC_INVALID_FIELD', `${at}/kind`);
      return;
    }
    if (AI_KINDS.has(kind)) {
      c.add('PROC_AI_STEP_DISABLED', `${at}/kind`);
      return;
    }
    if (kind !== 'capability' && kind !== 'decision') {
      c.add('PROC_UNSUPPORTED_NODE', `${at}/kind`);
      void UNSUPPORTED_KINDS;
      return;
    }
    if (id !== undefined) kindOf.set(id, kind);
    const out: string[] = [];
    if (id !== undefined) edges.set(id, out);
    const target = (k: string): void => {
      const v = c.str(s, k, at, true);
      if (v === undefined) return;
      if (!ids.has(v)) c.add('PROC_DANGLING_EDGE', `${at}/${k}`);
      else out.push(v);
    };
    if (kind === 'decision') {
      c.fields(s, ['id', 'kind', 'condition', 'then', 'else'], at);
      checkCondition(own(s, 'condition'), `${at}/condition`, ids, c);
      const cnd = own(s, 'condition');
      const cp = isObj(cnd) ? own(cnd, 'path') : undefined;
      if (id !== undefined && typeof cp === 'string' && cp.startsWith('steps.')) {
        const prod = cp.split('.')[1] as string;
        if (ids.has(prod)) bindingEdges.push({ consumer: id, producer: prod, at: `${at}/condition/path` });
      }
      target('then');
      target('else');
      return;
    }
    c.fields(
      s,
      ['id', 'kind', 'capabilityId', 'contractId', 'do', 'inputBindings', 'basis', 'evidence', 'onFailure', 'effectIntent', 'next'],
      at,
    );
    c.str(s, 'capabilityId', at, true);
    if (own(s, 'contractId') !== undefined) c.str(s, 'contractId', at, false);
    if (own(s, 'do') !== undefined) c.str(s, 'do', at, false);
    const basis = own(s, 'basis');
    if (basis !== undefined && !['source_proven', 'source_suggested', 'author_asserted'].includes(basis as string))
      c.add('PROC_INVALID_FIELD', `${at}/basis`);
    const of = own(s, 'onFailure');
    if (of !== undefined && !['fail', 'hold_for_human'].includes(of as string)) c.add('PROC_INVALID_FIELD', `${at}/onFailure`);
    const ei = own(s, 'effectIntent');
    if (ei !== undefined && ei !== 'read' && ei !== 'write') c.add('PROC_INVALID_FIELD', `${at}/effectIntent`);
    const ev = own(s, 'evidence');
    if (ev !== undefined) {
      if (!Array.isArray(ev)) c.add('PROC_INVALID_FIELD', `${at}/evidence`);
      else
        ev.forEach((e, j) => {
          const ep = `${at}/evidence/${j}`;
          if (!isObj(e)) {
            c.add('PROC_INVALID_FIELD', ep);
            return;
          }
          c.fields(e, ['documentPath', 'sectionPath'], ep);
          c.str(e, 'documentPath', ep, true);
          const sp = own(e, 'sectionPath');
          if (sp !== undefined && (!Array.isArray(sp) || sp.some((x) => typeof x !== 'string')))
            c.add('PROC_INVALID_FIELD', `${ep}/sectionPath`);
        });
    }
    if (own(s, 'next') !== undefined) target('next');
    const ib = own(s, 'inputBindings');
    if (ib !== undefined) {
      if (!Array.isArray(ib)) c.add('PROC_INVALID_FIELD', `${at}/inputBindings`);
      else
        ib.forEach((b, j) => {
          const bp = `${at}/inputBindings/${j}`;
          if (!isObj(b)) {
            c.add('PROC_INVALID_FIELD', bp);
            return;
          }
          c.fields(b, ['param', 'from', 'bindingStatus', 'reason'], bp);
          c.str(b, 'param', bp, true);
          const bs = own(b, 'bindingStatus');
          if (bs !== undefined && bs !== 'proven' && bs !== 'author_asserted') c.add('PROC_INVALID_FIELD', `${bp}/bindingStatus`);
          if (bs === 'author_asserted') c.str(b, 'reason', bp, true);
          else if (own(b, 'reason') !== undefined) c.str(b, 'reason', bp, false);
          const from = own(b, 'from');
          if (!isObj(from)) {
            c.add('PROC_INVALID_FIELD', `${bp}/from`);
            return;
          }
          const fp = `${bp}/from`;
          if (own(from, 'input') !== undefined) {
            c.fields(from, ['input'], fp);
            checkPath(`input.${String(own(from, 'input'))}`, `${fp}/input`, ids, c);
          } else if (own(from, 'step') !== undefined) {
            c.fields(from, ['step', 'output'], fp);
            const st = own(from, 'step');
            if (typeof st !== 'string' || !ID.test(st) || FORBIDDEN_KEYS.has(st)) c.add('PROC_INVALID_FIELD', `${fp}/step`);
            else if (!ids.has(st)) c.add('PROC_DANGLING_REFERENCE', `${fp}/step`);
            else if (id !== undefined) bindingEdges.push({ consumer: id, producer: st, at: `${fp}/step` });
            const o = own(from, 'output');
            if (typeof o !== 'string') c.add('PROC_MISSING_FIELD', `${fp}/output`);
            else
              checkPath(
                `steps.${typeof st === 'string' ? st : 'x'}.output.${o}`,
                `${fp}/output`,
                new Set([typeof st === 'string' ? st : 'x']),
                c,
              );
          } else c.add('PROC_INVALID_FIELD', fp);
        });
    }
  });

  for (const k of ['when', 'then'] as const) {
    const v = own(doc, k);
    if (v === undefined) continue;
    if (!Array.isArray(v)) c.add('PROC_INVALID_FIELD', `/${k}`);
    else
      v.forEach((cond, j) => {
        const cat = `/${k}/${j}`;
        checkCondition(cond, cat, ids, c);
        const cpath = isObj(cond) ? own(cond, 'path') : undefined;
        if (typeof cpath !== 'string' || !cpath.startsWith('steps.')) return;
        // `when` is evaluated before any step runs: it cannot reference step outputs.
        if (k === 'when') c.add('PROC_INVALID_PATH', `${cat}/path`);
        else {
          const prod = cpath.split('.')[1] as string;
          if (ids.has(prod)) stepRefs.push({ producer: prod, at: `${cat}/path` });
        }
      });
  }

  // A referenced output producer must be a capability step (decisions produce no output).
  for (const r of [...bindingEdges, ...stepRefs]) {
    if (kindOf.get(r.producer) !== 'capability') c.add('PROC_DANGLING_REFERENCE', r.at);
  }

  // Graph analysis only over a structurally sound step list.
  if (
    !c.findings.some(
      (f) =>
        f.code === 'PROC_DUPLICATE_ID' ||
        f.code === 'PROC_DANGLING_EDGE' ||
        f.code === 'PROC_INVALID_FIELD' ||
        f.code === 'PROC_MISSING_FIELD',
    )
  ) {
    graphChecks(edges, bindingEdges, c);
  }
  return c.findings.length > 0 ? { findings: c.findings } : { findings: [], definition: doc as unknown as ProcedureDefinition };
}

/** Iterative graph analysis (no recursion): entry uniqueness, cycles, reachability, binding upstream-ness. */
function graphChecks(edges: Map<string, string[]>, bindings: { consumer: string; producer: string; at: string }[], c: Ctx): void {
  const nodes = [...edges.keys()];
  if (nodes.length === 0) return;
  const incoming = new Map<string, number>(nodes.map((k) => [k, 0]));
  for (const outs of edges.values()) for (const t of outs) incoming.set(t, (incoming.get(t) ?? 0) + 1);
  const sources = nodes.filter((k) => incoming.get(k) === 0);

  // cycle detection: iterative DFS with colors
  const color = new Map<string, 0 | 1 | 2>(nodes.map((k) => [k, 0]));
  let cyclic = false;
  for (const root of nodes) {
    if (color.get(root) !== 0) continue;
    const st: { n: string; i: number }[] = [{ n: root, i: 0 }];
    color.set(root, 1);
    while (st.length > 0) {
      const top = st[st.length - 1] as { n: string; i: number };
      const outs = edges.get(top.n) ?? [];
      if (top.i < outs.length) {
        const nx = outs[top.i++] as string;
        const col = color.get(nx);
        if (col === 1) cyclic = true;
        else if (col === 0) {
          color.set(nx, 1);
          st.push({ n: nx, i: 0 });
        }
      } else {
        color.set(top.n, 2);
        st.pop();
      }
    }
  }
  if (cyclic) c.add('PROC_GRAPH_CYCLE', '/steps');
  if (sources.length > 1) c.add('PROC_AMBIGUOUS_ORDER', '/steps');
  if (sources.length === 0 && !cyclic) c.add('PROC_AMBIGUOUS_ORDER', '/steps');

  // reachability from the unique entry
  const reach = new Set<string>();
  if (sources.length === 1) {
    const q = [sources[0] as string];
    while (q.length > 0) {
      const n = q.pop() as string;
      if (reach.has(n)) continue;
      reach.add(n);
      for (const t of edges.get(n) ?? []) q.push(t);
    }
    if (reach.size !== nodes.length) c.add('PROC_UNREACHABLE', '/steps');
  }

  // a bound producer must lie strictly upstream of its consumer (and not be a decision)
  if (!cyclic) {
    for (const b of bindings) {
      const seen = new Set<string>();
      const q = [b.producer];
      let found = false;
      while (q.length > 0) {
        const n = q.pop() as string;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const t of edges.get(n) ?? []) {
          if (t === b.consumer) found = true;
          q.push(t);
        }
      }
      if (!found) c.add('PROC_BINDING_NOT_UPSTREAM', b.at);
    }
  }
}
