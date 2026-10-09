import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { capabilityScope, globalScope, hostScope, packageScope, pathScope, resourceScope, scopeContains, scopeKey, scopeSpecificity } from '../src/scope.js';

test('scope: global grants authorize anything, including no scope', () => {
  assert.equal(scopeContains(globalScope(), undefined), true);
  assert.equal(scopeContains(globalScope(), pathScope('/etc')), true);
  assert.equal(scopeContains(globalScope(), hostScope('evil.example.com')), true);
});

test('scope: a scoped grant never authorizes an unscoped ("global") request', () => {
  assert.equal(scopeContains(pathScope('/workspace'), undefined), false);
});

test('scope: path containment is segment-boundary aware (§14 worked example)', () => {
  const granted = pathScope('/workspace/project');
  assert.equal(scopeContains(granted, pathScope('/workspace/project')), true);
  assert.equal(scopeContains(granted, pathScope('/workspace/project/src/index.ts')), true);
  assert.equal(scopeContains(granted, pathScope('/workspace/project-secret')), false);
  assert.equal(scopeContains(granted, pathScope('/etc')), false);
});

test('scope: a broader path grant authorizes a narrower requested path', () => {
  assert.equal(scopeContains(pathScope('/workspace'), pathScope('/workspace/project')), true);
  assert.equal(scopeContains(pathScope('/workspace'), pathScope('/workspace-secret')), false);
});

test('scope: trailing slash is normalized', () => {
  assert.equal(scopeKey(pathScope('/workspace/')), scopeKey(pathScope('/workspace')));
});

test('scope: host containment supports exact and "*." wildcard subdomain match only', () => {
  assert.equal(scopeContains(hostScope('api.example.com'), hostScope('api.example.com')), true);
  assert.equal(scopeContains(hostScope('*.example.com'), hostScope('api.example.com')), true);
  assert.equal(scopeContains(hostScope('*.example.com'), hostScope('example.com')), false);
  assert.equal(scopeContains(hostScope('*.example.com'), hostScope('evilexample.com')), false);
  assert.equal(scopeContains(hostScope('api.example.com'), hostScope('other.example.com')), false);
});

test('scope: resource/package/capability scopes require exact match, no partial escalation', () => {
  assert.equal(scopeContains(resourceScope('OPENAI_API_KEY'), resourceScope('OPENAI_API_KEY')), true);
  assert.equal(scopeContains(resourceScope('OPENAI_API_KEY'), resourceScope('OPENAI_API_KEY_BACKUP')), false);

  const pkgA = PackageId('pkg-a');
  const pkgB = PackageId('pkg-ab');
  assert.equal(scopeContains(packageScope(pkgA), packageScope(pkgA)), true);
  assert.equal(scopeContains(packageScope(pkgA), packageScope(pkgB)), false);

  assert.equal(scopeContains(capabilityScope('financial.document.read'), capabilityScope('financial.document.read')), true);
  assert.equal(scopeContains(capabilityScope('financial.document.read'), capabilityScope('financial.document.write')), false);
});

test('scope: different scope kinds never match each other, even with overlapping string content', () => {
  assert.equal(scopeContains(pathScope('api.example.com'), hostScope('api.example.com')), false);
  assert.equal(scopeContains(resourceScope('/workspace'), pathScope('/workspace')), false);
});

test('scope: specificity ranks narrower path scopes above broader ones, and both above global', () => {
  const global = scopeSpecificity(globalScope());
  const broad = scopeSpecificity(pathScope('/workspace'));
  const narrow = scopeSpecificity(pathScope('/workspace/project'));
  assert.ok(global < broad);
  assert.ok(broad < narrow);
});

test('scope: pinned host is more specific than a wildcard host', () => {
  assert.ok(scopeSpecificity(hostScope('api.example.com')) > scopeSpecificity(hostScope('*.example.com')));
});
