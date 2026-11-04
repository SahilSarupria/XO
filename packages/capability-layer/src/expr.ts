/**
 * A small, safe expression language for decision-tree tests/computations and
 * safety-rule predicates. No `eval`, no property access, no calls except the
 * fixed function table below — an XO is untrusted content (SPECIFICATION.md §8)
 * so its expressions must never be able to reach the host.
 *
 * Grammar (lowest → highest precedence):
 *   ternary:  or ('?' ternary ':' ternary)?
 *   or:       and ('||' and)*          (short-circuits)
 *   and:      eq  ('&&' eq)*           (short-circuits)
 *   eq:       rel (('=='|'!=') rel)*
 *   rel:      add (('<'|'<='|'>'|'>=') add)*
 *   add:      mul (('+'|'-') mul)*
 *   mul:      unary (('*'|'/'|'%') unary)*
 *   unary:    ('!'|'-') unary | primary
 *   primary:  number | 'string' | true | false | null | ident | fn(args) | '(' ternary ')'
 *
 * Identifiers resolve against a scope of facts. A reference to an identifier
 * that is not in scope throws {@link MissingFactError} — because `&&`, `||`
 * and `?:` short-circuit, a fact is only "needed" if the evaluated path
 * actually reads it.
 */

export type Value = number | string | boolean | null;
export type Scope = Readonly<Record<string, Value | undefined>>;

export class MissingFactError extends Error {
  constructor(readonly fact: string) {
    super(`missing fact: ${fact}`);
    this.name = 'MissingFactError';
  }
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',', '?', ':'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j] as string)) j++;
      const n = Number(src.slice(i, j).replace(/_/g, ''));
      if (!Number.isFinite(n)) throw new ExpressionError(`bad number near "${src.slice(i, j)}"`);
      out.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j];
        j++;
      }
      if (src[j] !== c) throw new ExpressionError('unterminated string literal');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ExpressionError(`unexpected character "${c}"`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

type Ast =
  | { k: 'lit'; v: Value }
  | { k: 'id'; name: string }
  | { k: 'un'; op: string; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'cond'; c: Ast; a: Ast; b: Ast }
  | { k: 'call'; fn: string; args: Ast[] };

class Parser {
  private p = 0;
  constructor(private readonly toks: Token[]) {}
  parse(): Ast {
    const a = this.ternary();
    if (this.p < this.toks.length) throw new ExpressionError('unexpected trailing tokens');
    return a;
  }
  private peekOp(...ops: string[]): string | undefined {
    const t = this.toks[this.p];
    return t !== undefined && t.t === 'op' && ops.includes(t.v) ? t.v : undefined;
  }
  private eat(op: string): void {
    if (this.peekOp(op) === undefined) throw new ExpressionError(`expected "${op}"`);
    this.p++;
  }
  private ternary(): Ast {
    const c = this.or();
    if (this.peekOp('?') !== undefined) {
      this.p++;
      const a = this.ternary();
      this.eat(':');
      const b = this.ternary();
      return { k: 'cond', c, a, b };
    }
    return c;
  }
  private binary(next: () => Ast, ...ops: string[]): Ast {
    let a = next();
    for (let op = this.peekOp(...ops); op !== undefined; op = this.peekOp(...ops)) {
      this.p++;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  }
  private or = (): Ast => this.binary(this.and, '||');
  private and = (): Ast => this.binary(this.eq, '&&');
  private eq = (): Ast => this.binary(this.rel, '==', '!=');
  private rel = (): Ast => this.binary(this.add, '<=', '>=', '<', '>');
  private add = (): Ast => this.binary(this.mul, '+', '-');
  private mul = (): Ast => this.binary(this.unary, '*', '/', '%');
  private unary = (): Ast => {
    const op = this.peekOp('!', '-');
    if (op !== undefined) {
      this.p++;
      return { k: 'un', op, a: this.unary() };
    }
    return this.primary();
  };
  private primary(): Ast {
    const t = this.toks[this.p];
    if (t === undefined) throw new ExpressionError('unexpected end of expression');
    this.p++;
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (this.peekOp('(') !== undefined) {
        this.p++;
        const args: Ast[] = [];
        if (this.peekOp(')') === undefined) {
          args.push(this.ternary());
          while (this.peekOp(',') !== undefined) {
            this.p++;
            args.push(this.ternary());
          }
        }
        this.eat(')');
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'id', name: t.v };
    }
    if (t.v === '(') {
      const a = this.ternary();
      this.eat(')');
      return a;
    }
    throw new ExpressionError(`unexpected token "${t.v}"`);
  }
}

const cache = new Map<string, Ast>();
function compile(src: string): Ast {
  let ast = cache.get(src);
  if (ast === undefined) {
    ast = new Parser(tokenize(src)).parse();
    cache.set(src, ast);
  }
  return ast;
}

function num(v: Value, what: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new ExpressionError(`${what} expects a number, got ${JSON.stringify(v)}`);
  return v;
}

const FUNCS: Record<string, (args: Value[]) => Value> = {
  min: (a) => Math.min(...a.map((x) => num(x, 'min'))),
  max: (a) => Math.max(...a.map((x) => num(x, 'max'))),
  abs: (a) => Math.abs(num(a[0] ?? null, 'abs')),
  floor: (a) => Math.floor(num(a[0] ?? null, 'floor')),
  ceil: (a) => Math.ceil(num(a[0] ?? null, 'ceil')),
  round: (a) => {
    const x = num(a[0] ?? null, 'round');
    const d = a[1] === undefined ? 0 : num(a[1], 'round');
    const f = 10 ** d;
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  /** case-insensitive substring test, used by input-side safety rules */
  contains: (a) =>
    String(a[0] ?? '')
      .toLowerCase()
      .includes(String(a[1] ?? '').toLowerCase()),
};

function ev(ast: Ast, scope: Scope): Value {
  switch (ast.k) {
    case 'lit':
      return ast.v;
    case 'id': {
      const v = scope[ast.name];
      if (v === undefined) throw new MissingFactError(ast.name);
      return v;
    }
    case 'un': {
      const a = ev(ast.a, scope);
      return ast.op === '!' ? !a : -num(a, 'unary -');
    }
    case 'cond':
      return ev(ast.c, scope) ? ev(ast.a, scope) : ev(ast.b, scope);
    case 'call': {
      const f = FUNCS[ast.fn];
      if (f === undefined) throw new ExpressionError(`unknown function "${ast.fn}"`);
      return f(ast.args.map((x) => ev(x, scope)));
    }
    case 'bin': {
      if (ast.op === '&&') return ev(ast.a, scope) ? ev(ast.b, scope) : false;
      if (ast.op === '||') return ev(ast.a, scope) ? true : Boolean(ev(ast.b, scope));
      const a = ev(ast.a, scope);
      const b = ev(ast.b, scope);
      switch (ast.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
          return num(a, '<') < num(b, '<');
        case '<=':
          return num(a, '<=') <= num(b, '<=');
        case '>':
          return num(a, '>') > num(b, '>');
        case '>=':
          return num(a, '>=') >= num(b, '>=');
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? String(a) + String(b) : num(a, '+') + num(b, '+');
        case '-':
          return num(a, '-') - num(b, '-');
        case '*':
          return num(a, '*') * num(b, '*');
        case '/': {
          const d = num(b, '/');
          if (d === 0) throw new ExpressionError('division by zero');
          return num(a, '/') / d;
        }
        case '%':
          return num(a, '%') % num(b, '%');
      }
      throw new ExpressionError(`unknown operator ${ast.op}`);
    }
  }
}

/** Evaluates `source` against `scope`. Throws {@link MissingFactError} / {@link ExpressionError}. */
export function evaluateExpression(source: string, scope: Scope): Value {
  return ev(compile(source), scope);
}

/** Static syntax check — throws {@link ExpressionError} if `source` does not parse. */
export function assertExpressionParses(source: string): void {
  compile(source);
}
