import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustedProxyHops, resolveClientAddress } from '../src/http/client-address.js';

test('no trusted proxy: the TCP peer is used and X-Forwarded-For is ignored', () => {
  assert.equal(resolveClientAddress('10.0.0.1', '203.0.113.5', 0), '10.0.0.1');
});

test('one trusted proxy: the entry the proxy appended is used; client-supplied entries to its left are ignored', () => {
  assert.equal(resolveClientAddress('10.0.0.1', '203.0.113.5', 1), '203.0.113.5');
  assert.equal(resolveClientAddress('10.0.0.1', '6.6.6.6, 203.0.113.5', 1), '203.0.113.5');
});

test('two trusted proxies: the client is two entries from the right', () => {
  assert.equal(resolveClientAddress('10.0.0.2', '203.0.113.5, 10.0.0.1', 2), '203.0.113.5');
});

test('a missing, too-short, oversized or malformed header falls back to the TCP peer', () => {
  assert.equal(resolveClientAddress('10.0.0.1', undefined, 1), '10.0.0.1');
  assert.equal(resolveClientAddress('10.0.0.1', '203.0.113.5', 2), '10.0.0.1');
  assert.equal(resolveClientAddress('10.0.0.1', 'not-an-ip', 1), '10.0.0.1');
  assert.equal(resolveClientAddress('10.0.0.1', `${'1.1.1.1,'.repeat(400)}2.2.2.2`, 1), '10.0.0.1');
  assert.equal(resolveClientAddress(undefined, '203.0.113.5', 1), undefined);
});

test('IPv6 addresses are accepted; multiple header lines are joined', () => {
  assert.equal(resolveClientAddress('10.0.0.1', '2001:db8::1', 1), '2001:db8::1');
  assert.equal(resolveClientAddress('10.0.0.1', ['6.6.6.6', '203.0.113.5'], 1), '203.0.113.5');
});

test('XO_API_TRUSTED_PROXY_HOPS: unset is 0; 0..5 accepted; anything else is a configuration error', () => {
  assert.equal(parseTrustedProxyHops(undefined), 0);
  assert.equal(parseTrustedProxyHops(''), 0);
  assert.equal(parseTrustedProxyHops('2'), 2);
  for (const bad of ['-1', '6', '1.5', 'yes', '1 2']) assert.throws(() => parseTrustedProxyHops(bad), /XO_API_TRUSTED_PROXY_HOPS/);
});
