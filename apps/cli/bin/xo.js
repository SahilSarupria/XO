#!/usr/bin/env node
import { run } from '../dist/index.js';

// The terminal streams are passed in explicitly: interactive mode, colors, and
// piped-stdin reading for `xo -p` are enabled only here, never inside run() itself.
process.exitCode = await run(process.argv.slice(2), undefined, {
  terminal: { stdin: process.stdin, stdout: process.stdout, env: process.env },
});
