import { Sha256Hasher } from '@xo/crypto';

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace,
 * strings/numbers serialised by JSON.stringify. Iterative (no recursion).
 * Strings are hashed as authored (no Unicode normalisation): two documents that
 * differ in normalisation form are different documents.
 */
export function canonicalJson(root: unknown): string {
  const out: string[] = [];
  type Work = { t: 'v'; v: unknown } | { t: 's'; s: string };
  const stack: Work[] = [{ t: 'v', v: root }];
  while (stack.length > 0) {
    const w = stack.pop() as Work;
    if (w.t === 's') {
      out.push(w.s);
      continue;
    }
    const v = w.v;
    if (Array.isArray(v)) {
      stack.push({ t: 's', s: ']' });
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push({ t: 'v', v: v[i] });
        if (i > 0) stack.push({ t: 's', s: ',' });
      }
      out.push('[');
    } else if (typeof v === 'object' && v !== null) {
      const keys = Object.keys(v).sort();
      stack.push({ t: 's', s: '}' });
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i] as string;
        stack.push({ t: 'v', v: (v as Record<string, unknown>)[k] });
        stack.push({ t: 's', s: `${JSON.stringify(k)}:` });
        if (i > 0) stack.push({ t: 's', s: ',' });
      }
      out.push('{');
    } else out.push(JSON.stringify(v) ?? 'null');
  }
  return out.join('');
}

export function procedureHash(definition: unknown): string {
  return new Sha256Hasher().hash(canonicalJson(definition));
}
