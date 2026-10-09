import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../src/container.js';
import { createToken } from '../src/tokens.js';

test('resolves a registered singleton to the same instance', () => {
  const container = new Container();
  const token = createToken<{ id: number }>('Thing');
  let calls = 0;
  container.register(token, () => {
    calls += 1;
    return { id: calls };
  });
  const a = container.resolve(token);
  const b = container.resolve(token);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test('transient scope creates a new instance per resolve', () => {
  const container = new Container();
  const token = createToken<{ id: number }>('Thing');
  let calls = 0;
  container.register(
    token,
    () => {
      calls += 1;
      return { id: calls };
    },
    'transient',
  );
  container.resolve(token);
  container.resolve(token);
  assert.equal(calls, 2);
});

test('resolving an unregistered token throws DiError', () => {
  const container = new Container();
  const token = createToken<string>('Missing');
  assert.throws(() => container.resolve(token), /No registration for token "Missing"/);
});

test('detects circular dependencies', () => {
  const container = new Container();
  const a = createToken<unknown>('A');
  const b = createToken<unknown>('B');
  container.register(a, (c) => c.resolve(b));
  container.register(b, (c) => c.resolve(a));
  assert.throws(() => container.resolve(a), /Circular dependency detected/);
});

test('createChild falls back to the parent for tokens it does not own', () => {
  const parent = new Container();
  const token = createToken<string>('Shared');
  parent.registerValue(token, 'from-parent');
  const child = parent.createChild();
  assert.equal(child.resolve(token), 'from-parent');
});

test('createChild registrations shadow the parent', () => {
  const parent = new Container();
  const token = createToken<string>('Shared');
  parent.registerValue(token, 'from-parent');
  const child = parent.createChild();
  child.registerValue(token, 'from-child');
  assert.equal(child.resolve(token), 'from-child');
});
