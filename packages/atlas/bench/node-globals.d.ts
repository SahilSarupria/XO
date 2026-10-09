// Minimal ambient typings for the Node globals used by bench.ts, so the
// benchmark script type-checks without pulling in @types/node or the DOM lib.

declare const console: { log(...args: unknown[]): void }
declare const performance: { now(): number }
