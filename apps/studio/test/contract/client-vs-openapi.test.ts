// @vitest-environment node
/**
 * CONTRACT TEST (S1-12): every route Studio's client calls is in the API's own OpenAPI document, with that method. The fake used by
 * the other tests can only be as true as the client's idea of the API, so this keeps both honest against the API's published routes.
 * It reads the client's source (the call sites are the contract Studio relies on) and the document the API serves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../../../api/src/openapi';

const CONNECT = '/connect/';
const CLIENT = readFileSync(fileURLToPath(new URL('../../src/platform/client.ts', import.meta.url)), 'utf8');
const shape = (path: string): string =>
  path
    .split('/')
    .map((seg) => (seg.includes('{') || seg.includes('${') ? '{}' : seg))
    .join('/');

const documented = new Map<string, Set<string>>();
for (const [path, item] of Object.entries(openApiDocument.paths as unknown as Record<string, Record<string, unknown>>)) {
  const key = shape(path);
  const set = documented.get(key) ?? new Set<string>();
  for (const m of Object.keys(item)) set.add(m.toUpperCase());
  documented.set(key, set);
}

/** `this.call('GET', `/workspaces/${enc(ws)}/x?${qs}`` and the quoted form: the method and the path without its query. */
function calls(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const re = /this\.call(?:<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*([`'])((?:\\.|(?!\2)[\s\S])*)\2/g;
  for (const m of CLIENT.matchAll(re)) {
    let p = m[3] ?? '';
    // Drop an optional query suffix: `${qs.length > 0 ? `?${qs}` : ''}` or a literal `?a=b`.
    const cut = p.search(/\$\{[^}]*\?[^}]*\}|\?/);
    if (cut >= 0 && !p.slice(0, cut).endsWith('${')) p = p.slice(0, cut);
    out.push({ method: m[1] ?? '', path: shape(p) });
  }
  return out;
}

describe('Studio client against the API document', () => {
  const found = calls();

  it('finds the client call sites (a sanity floor, so the scan cannot silently read nothing)', () => {
    expect(found.length).toBeGreaterThan(120);
  });

  /** A call whose path is built from a variable (`${base}/x`, `/${verb}`) is matched with that part as a wildcard; a path that starts with a variable cannot be checked. */
  const matches = (c: { method: string; path: string }): boolean => {
    const want = c.path.split('/');
    return [...documented.entries()].some(
      ([key, methods]) =>
        methods.has(c.method) &&
        key.split('/').length === want.length &&
        key.split('/').every((seg, i) => seg === want[i] || want[i] === '{}'),
    );
  };

  it('every route the client calls is documented with that method', () => {
    const missing = found
      .filter((c) => !c.path.startsWith('{}') && !c.path.startsWith(CONNECT))
      .filter((c) => !matches(c))
      .map((c) => `${c.method} ${c.path}`)
      .filter((v, i, a) => a.indexOf(v) === i);
    expect(missing).toEqual([]);
  });

  it('knows the one part of the API that is served but not yet in the document: Connect (/connect/...)', () => {
    // Recorded in the readiness report as an API item. When Connect is documented this fails, so the exception is removed.
    const connect = found.filter((c) => c.path.startsWith(CONNECT));
    expect(connect.length).toBeGreaterThan(0);
    expect(connect.every((c) => !matches(c))).toBe(true);
  });
});
