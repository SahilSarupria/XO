// Minimal ambient typings for the subset of Node's built-in `node:test`
// and `node:assert/strict` modules used by this package's test suite.
// atlas has zero runtime dependencies; these declarations exist purely
// so tests type-check without requiring @types/node.

declare module 'node:test' {
  export type TestFn = () => void | Promise<void>
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: TestFn): void
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): void
    throws(fn: () => unknown, message?: string): void
  }
  const assert: Assert
  export default assert
}
