#!/usr/bin/env node
import { runStdio } from './stdio.js';

/* eslint-disable no-console -- the guard below IS the console policy: stray console output must go to stderr, never stdout */
// stdout is reserved for MCP frames: any stray console.log (ours or a dependency's) is redirected to stderr.
console.log = (...args: unknown[]): void => void process.stderr.write(`${args.map(String).join(' ')}\n`);
console.info = console.log;
console.debug = console.log;

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => controller.abort());
// stdin end-of-file is the MCP stdio shutdown signal; the SDK transport closes the server when it sees it.
runStdio({ env: process.env }, controller.signal).then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('{"level":"warn","event":"fatal"}\n');
    process.exit(1);
  },
);
