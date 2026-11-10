import { FORBIDDEN_KEYS, MAX_PROCEDURE_BYTES, MAX_PROCEDURE_DEPTH, MAX_PROCEDURE_STEPS, type ProcedureFinding } from './codes.js';

/**
 * Iterative (non-recursive) strict JSON parser operating on raw text.
 *
 * Why not JSON.parse: it silently drops duplicate keys and cannot report them,
 * and plain-object assignment of `__proto__` is a pollution vector. This parser
 * (a) reports duplicate keys, (b) reports forbidden keys at any depth and never
 * materialises them, (c) builds null-prototype objects, and (d) uses an explicit
 * stack so deeply nested input cannot overflow the call stack.
 *
 * Owner-approved limits (P1.1 O-2 / N-10, 2026-10-18), enforced here and nowhere
 * else, as library-owned constants (not caller options):
 *   - raw input <= MAX_PROCEDURE_BYTES UTF-8 bytes, checked BEFORE decoding/parsing;
 *   - nesting depth <= MAX_PROCEDURE_DEPTH containers (root container = depth 1);
 *   - top-level `steps` array <= MAX_PROCEDURE_STEPS entries (only the array at
 *     JSON pointer `/steps`; arrays elsewhere are never counted).
 * Limit failures are fail-fast, deterministic in scan order, and carry a constant
 * path (no input-derived text). No node/edge/string-length caps exist.
 */
export type ParseResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly findings: readonly ProcedureFinding[] };

const enc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

type Frame =
  | {
      kind: 'obj';
      value: Record<string, unknown>;
      path: string;
      seen: Set<string>;
      key: string | null;
      state: 'key' | 'colon' | 'value' | 'comma';
    }
  | { kind: 'arr'; value: unknown[]; path: string; state: 'value' | 'comma'; steps: boolean };

export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const limitFailure = (code: ProcedureFinding['code'], path: string): ParseResult => ({ ok: false, findings: [{ code, path }] });

/**
 * UTF-8 byte length of a JS string (NOT its UTF-16 length). Surrogate pairs = 4 bytes,
 * lone surrogates = 3 bytes (what TextEncoder emits, U+FFFD). Stops as soon as `cap` is
 * exceeded, so work is bounded by cap + 1 code units regardless of input size.
 */
export function utf8ByteLengthExceeds(s: string, cap: number): boolean {
  let bytes = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && k + 1 < s.length && (s.charCodeAt(k + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      k++;
    } else bytes += 3;
    if (bytes > cap) return true;
  }
  return false;
}

export function parseStrictJson(input: string | Uint8Array): ParseResult {
  let text: string;
  if (typeof input === 'string') {
    if (utf8ByteLengthExceeds(input, MAX_PROCEDURE_BYTES)) return limitFailure('PROC_BODY_TOO_LARGE', '');
    text = input;
  } else {
    if (input.byteLength > MAX_PROCEDURE_BYTES) return limitFailure('PROC_BODY_TOO_LARGE', '');
    const d = decodeUtf8Strict(input);
    if (d === null) return { ok: false, findings: [{ code: 'PROC_INVALID_ENCODING', path: '' }] };
    text = d;
  }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, findings: [{ code: 'PROC_INVALID_ENCODING', path: '' }] };

  const findings: ProcedureFinding[] = [];
  const fail = (code: ProcedureFinding['code'], path: string): ParseResult => ({ ok: false, findings: [...findings, { code, path }] });
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };

  const readString = (): string | null => {
    // text[i] === '"'
    i++;
    let out = '';
    let start = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) return null;
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e === undefined) return null;
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else return null;
        start = i;
        continue;
      }
      i++;
    }
    return null;
  };

  const readScalar = (): { ok: true; value: unknown } | { ok: false } => {
    const c = text[i];
    if (c === '"') {
      const s = readString();
      return s === null ? { ok: false } : { ok: true, value: s };
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return { ok: true, value: true };
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return { ok: true, value: false };
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return { ok: true, value: null };
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400 > n ? n : i + 400));
    if (!m) return { ok: false };
    // Re-read exact token if it exceeded the 400-char window (no length cap is imposed).
    let tok = m[0];
    if (tok.length === 400) {
      const m2 = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      tok = m2 ? m2[0] : tok;
    }
    i += tok.length;
    const num = Number(tok);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, value: num };
  };

  const stack: Frame[] = [];
  let root: unknown;
  let haveRoot = false;

  // Deliver a completed value to the enclosing frame (or the root).
  const deliver = (value: unknown): ParseResult | null => {
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      haveRoot = true;
      return null;
    }
    if (top.kind === 'arr') {
      top.value.push(value);
      top.state = 'comma';
      return null;
    }
    const key = top.key as string;
    top.value[key] = value;
    top.state = 'comma';
    top.key = null;
    return null;
  };
  const childPath = (): string => {
    const top = stack[stack.length - 1];
    if (!top) return '';
    if (top.kind === 'arr') return `${top.path}/${top.value.length}`;
    return `${top.path}/${enc(top.key as string)}`;
  };

  ws();
  while (true) {
    ws();
    const top = stack[stack.length - 1];
    if (top && top.kind === 'obj' && top.state === 'key') {
      if (text[i] === '}' && top.seen.size === 0) {
        i++;
        stack.pop();
        deliver(top.value);
        continue;
      }
      if (text[i] !== '"') return fail('PROC_INVALID_JSON', top.path);
      const k = readString();
      if (k === null) return fail('PROC_INVALID_JSON', top.path);
      const kp = `${top.path}/${enc(k)}`;
      if (FORBIDDEN_KEYS.has(k)) findings.push({ code: 'PROC_FORBIDDEN_KEY', path: kp });
      if (top.seen.has(k)) findings.push({ code: 'PROC_DUPLICATE_KEY', path: kp });
      top.seen.add(k);
      top.key = k;
      ws();
      if (text[i] !== ':') return fail('PROC_INVALID_JSON', kp);
      i++;
      top.state = 'value';
      continue;
    }
    if (top && top.state === 'comma') {
      const c = text[i];
      if (c === ',') {
        i++;
        top.state = top.kind === 'obj' ? 'key' : 'value';
        if (top.kind === 'obj') top.seen = top.seen;
        continue;
      }
      if (top.kind === 'obj' && c === '}') {
        i++;
        stack.pop();
        deliver(top.value);
        continue;
      }
      if (top.kind === 'arr' && c === ']') {
        i++;
        stack.pop();
        deliver(top.value);
        continue;
      }
      return fail('PROC_INVALID_JSON', top.path);
    }
    // expecting a value (root, object value, or array element)
    if (!top && haveRoot) break;
    const c = text[i];
    if (c === undefined) return fail('PROC_INVALID_JSON', '');
    if (top && top.kind === 'arr' && top.value.length === 0 && c === ']') {
      i++;
      stack.pop();
      deliver(top.value);
      continue;
    }
    if (top && top.kind === 'arr' && top.steps && top.value.length >= MAX_PROCEDURE_STEPS && /[{["tfn0-9-]/.test(c)) {
      return limitFailure('PROC_TOO_MANY_STEPS', '/steps');
    }
    if ((c === '{' || c === '[') && stack.length + 1 > MAX_PROCEDURE_DEPTH) return limitFailure('PROC_TOO_DEEP', '');
    if (c === '{') {
      i++;
      const path = childPath();
      const frame: Frame = {
        kind: 'obj',
        value: Object.create(null) as Record<string, unknown>,
        path,
        seen: new Set(),
        key: null,
        state: 'key',
      };
      stack.push(frame);
      // allow immediate empty object
      ws();
      if (text[i] === '}') {
        i++;
        stack.pop();
        deliver(frame.value);
      }
      continue;
    }
    if (c === '[') {
      i++;
      const path = childPath();
      stack.push({ kind: 'arr', value: [], path, state: 'value', steps: path === '/steps' });
      continue;
    }
    const s = readScalar();
    if (!s.ok) return fail('PROC_INVALID_JSON', childPath());
    deliver(s.value);
  }
  ws();
  if (i < n) return fail('PROC_INVALID_JSON', '');
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, value: root };
}
