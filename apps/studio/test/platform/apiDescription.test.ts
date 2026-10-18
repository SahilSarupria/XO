import { describe, expect, it } from 'vitest';
import { parseApiDescription, parseHealth, WireParseError } from '../../src/platform/wire';

describe('parseHealth', () => {
  it('reads the status the platform reports, and nothing else', () => {
    expect(parseHealth({ status: 'ok', extra: 1 })).toEqual({ status: 'ok' });
  });
  it('refuses anything that is not a health answer', () => {
    expect(() => parseHealth({})).toThrow(WireParseError);
    expect(() => parseHealth({ status: 1 })).toThrow(WireParseError);
    expect(() => parseHealth(null)).toThrow(WireParseError);
  });
});

describe('parseApiDescription', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'XO Platform API', version: '0.1.0', description: 'ignored' },
    paths: {
      '/health': { get: { summary: 'Liveness check', security: [] } },
      '/workspaces': { get: { summary: 'List workspaces' }, post: {}, parameters: [{ ignored: true }] },
    },
  };

  it('lists each operation with method, path, summary and whether it is open', () => {
    const d = parseApiDescription(doc);
    expect(d.title).toBe('XO Platform API');
    expect(d.version).toBe('0.1.0');
    expect(d.operations).toEqual([
      { method: 'GET', path: '/health', summary: 'Liveness check', requiresAuth: false },
      { method: 'GET', path: '/workspaces', summary: 'List workspaces', requiresAuth: true },
      { method: 'POST', path: '/workspaces', requiresAuth: true },
    ]);
  });

  it('only an explicit empty security list means open; absence means the key is needed', () => {
    expect(parseApiDescription({ ...doc, paths: { '/x': { get: {} } } }).operations[0]?.requiresAuth).toBe(true);
  });

  it('rejects a document it cannot trust rather than showing part of it', () => {
    expect(() => parseApiDescription({ info: { title: 'x' }, paths: {} })).toThrow(WireParseError);
    expect(() => parseApiDescription({ info: { title: 'x', version: '1' }, paths: [] })).toThrow(WireParseError);
    expect(() => parseApiDescription({ info: { title: 'x', version: '1' }, paths: { '/a': { get: { summary: 3 } } } })).toThrow(
      WireParseError,
    );
  });
});
