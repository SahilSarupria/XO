/**
 * C3: the only representation of a credential value outside the provider adapter and the credential broker.
 *
 * A `Secret` cannot be serialized, logged, inspected or concatenated into an error by accident: `toString`, `toJSON` and the Node
 * inspect hook all return a fixed placeholder, and the value lives in a module-private WeakMap (no own property to enumerate).
 * `revealSecret` is deliberately NOT re-exported from the package index; only code in `src/cloud` can unwrap a value.
 */
const values = new WeakMap<object, string>();
const REDACTED = '[redacted]';

export class Secret {
  constructor(value: string) {
    values.set(this, value);
    Object.freeze(this);
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export function revealSecret(secret: Secret): string {
  const value = values.get(secret);
  if (value === undefined) throw new TypeError('not a Secret');
  return value;
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === 'object' && value !== null && values.has(value);
}
