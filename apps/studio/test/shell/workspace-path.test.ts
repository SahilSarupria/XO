import { describe, expect, it } from 'vitest';
import { parseWorkspaceRelativePath } from '../../src/workspace/boundary';

describe('parseWorkspaceRelativePath', () => {
  it.each(['a.txt', 'dir/sub/file.md', 'policies/2026/claims.pdf', '.hidden/x'])('accepts %s', (p) => {
    expect(parseWorkspaceRelativePath(p)).toEqual({ ok: true, value: p });
  });
  it.each([
    '',
    '/etc/passwd',
    'C:\\Windows',
    'c:/x',
    '..',
    '../x',
    'a/../../x',
    'a/./b',
    'a//b',
    'a/',
    'a\\b',
    'a\u0000b',
    'a\nb',
    'con',
    'dir/NUL.txt',
    'file.',
    'file ',
    'a:b',
    'a?b',
    'x'.repeat(256),
    `${'a/'.repeat(600)}b`,
  ])('rejects %j', (p) => {
    expect(parseWorkspaceRelativePath(p).ok).toBe(false);
  });
});
