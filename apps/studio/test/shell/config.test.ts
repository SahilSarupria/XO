import { describe, expect, it } from 'vitest';
import { normaliseApiBaseUrl, resolveApiBaseUrl } from '../../src/shell/config';

describe('normaliseApiBaseUrl', () => {
  it.each([
    ['/api', '/api'],
    ['/api/', '/api'],
    ['/xo/api///', '/xo/api'],
    ['  /api ', '/api'],
    ['https://xo.example.com/api/', 'https://xo.example.com/api'],
    ['http://127.0.0.1:4000', 'http://127.0.0.1:4000'],
  ])('accepts %s', (input, out) => {
    expect(normaliseApiBaseUrl(input)).toEqual({ ok: true, value: out });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'ftp://host/api',
    '//evil.example.com/api',
    'https://user:pw@host/api',
    'https://host/api?x=1',
    'https://host/api#frag',
    '/api/../admin',
    '/api?x=1',
    'api',
    '',
    '   ',
    '/a b',
  ])('rejects %j', (input) => {
    expect(normaliseApiBaseUrl(input).ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(normaliseApiBaseUrl(42).ok).toBe(false);
    expect(normaliseApiBaseUrl({}).ok).toBe(false);
  });
});

describe('resolveApiBaseUrl precedence', () => {
  it('defaults to same-origin /api', () => {
    expect(resolveApiBaseUrl({})).toEqual({ ok: true, baseUrl: '/api', source: 'default' });
  });
  it('uses build-time over default', () => {
    expect(resolveApiBaseUrl({ buildTime: 'https://b.example/api' })).toEqual({
      ok: true,
      baseUrl: 'https://b.example/api',
      source: 'build',
    });
  });
  it('uses runtime over build-time', () => {
    const r = resolveApiBaseUrl({ runtime: { apiBaseUrl: 'https://r.example/api' }, buildTime: 'https://b.example/api' });
    expect(r).toEqual({ ok: true, baseUrl: 'https://r.example/api', source: 'runtime' });
  });
  it('treats an empty build-time value as unset', () => {
    expect(resolveApiBaseUrl({ buildTime: '  ' })).toMatchObject({ ok: true, source: 'default' });
  });
  it('fails (does not fall through) on an invalid runtime value', () => {
    const r = resolveApiBaseUrl({ runtime: { apiBaseUrl: 'javascript:x' }, buildTime: '/api' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.source).toBe('runtime');
      expect(r.message).toMatch(/scheme/);
    }
  });
  it('fails on an invalid build-time value', () => {
    const r = resolveApiBaseUrl({ buildTime: 'ftp://x' });
    expect(r.ok).toBe(false);
  });
});
