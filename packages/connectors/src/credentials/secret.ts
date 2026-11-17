/**
 * UW-9 — a credential value outside the store. It cannot be serialized, logged, inspected or put into an error by accident:
 * `toString`, `toJSON` and the Node inspect hook return a fixed placeholder, and the value lives in a module-private WeakMap (no
 * own property to enumerate). Only the code a broker hands it to unwraps it, with `revealSecret`, for the one call it is for.
 */
const values = new WeakMap<object, string>();
const REDACTED = '[redacted]';

export class Secret {
  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('a secret must be a non-empty string');
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
  const v = values.get(secret);
  if (v === undefined) throw new TypeError('not a Secret');
  return v;
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === 'object' && value !== null && values.has(value);
}
