import type { CommandRegistry } from '../../command-registry.js';
import { printResult } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { compileCommand } from './compile.js';
import { capabilitiesCommand } from './capabilities.js';
import { createCommand } from './create.js';

const SUBSYSTEM = 'compiler';

/**
 * Registers every command backed by `@xo/compiler`: `compile`,
 * `capabilities`, `create`. This subsystem previously declared itself
 * with zero commands ("no CLI-facing API exists yet") — that was true
 * when written, but `@xo/compiler` has since grown a real orchestrated
 * entry point (`compileSource`/`compileSources`, `pipeline/compile-sources.ts`)
 * and a real Packager (`packageXoirGraph`, `pipeline/packager.ts`). These
 * three commands are thin wrappers over those APIs, following the exact
 * same registration-vs-command split every other subsystem here uses —
 * see `compile.ts`/`capabilities.ts`/`create.ts` for what each actually
 * calls and what it deliberately does not invent.
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'compile',
    subsystem: SUBSYSTEM,
    usage:
      'xo compile <source>... [--domain-hint <text>] [--focus-question <text>] [--json]\n' +
      '                                         Compile one or more sources into XOIR and print a summary',
    run: async (args) => {
      const sources = args.positionals;
      if (sources.length === 0) {
        process.stdout.write('xo compile <source>... [--domain-hint <text>] [--focus-question <text>] [--json]\n');
        return 1;
      }
      const domainHint = requireFlag(args.flags, 'domain-hint');
      const focusQuestion = requireFlag(args.flags, 'focus-question');
      return printResult(
        await compileCommand({
          sources,
          json: args.flags['json'] === true,
          ...(domainHint !== undefined ? { domainHint } : {}),
          ...(focusQuestion !== undefined ? { focusQuestion } : {}),
        }),
      );
    },
  });

  registry.register({
    name: 'capabilities',
    subsystem: SUBSYSTEM,
    usage:
      'xo capabilities <source-or-archive.xo> [--domain-hint <text>] [--json]\n' +
      '                                         Show discovered (semantic) vs. resolved (manifest-declared)\n' +
      '                                         capabilities — never conflates the two',
    run: async (args) => {
      const target = args.positionals[0];
      if (!target) {
        process.stdout.write('xo capabilities <source-or-archive.xo> [--domain-hint <text>] [--json]\n');
        return 1;
      }
      const domainHint = requireFlag(args.flags, 'domain-hint');
      return printResult(await capabilitiesCommand({ target, json: args.flags['json'] === true, ...(domainHint !== undefined ? { domainHint } : {}) }));
    },
  });

  registry.register({
    name: 'create',
    subsystem: SUBSYSTEM,
    usage:
      'xo create <source>... [--name <n>] [--version <v>] [--creator-did <did>]\n' +
      '      [--domain <text>] [--description <text>] [--out <file.xo>]\n' +
      '      [--sign] [--signer-did <did>] [--key-out <prefix>] [--domain-hint <text>] [--json]\n' +
      '                                         Compile source(s) straight through to a signed, validated .xo',
    run: async (args) => {
      const sources = args.positionals;
      if (sources.length === 0) {
        process.stdout.write('xo create <source>... [--name <n>] [--version <v>] [--creator-did <did>] [--sign] [--json]\n');
        return 1;
      }
      const name = requireFlag(args.flags, 'name');
      const version = requireFlag(args.flags, 'version');
      const creatorDid = requireFlag(args.flags, 'creator-did');
      const domain = requireFlag(args.flags, 'domain');
      const description = requireFlag(args.flags, 'description');
      const out = requireFlag(args.flags, 'out');
      const signerDid = requireFlag(args.flags, 'signer-did');
      const keyOut = requireFlag(args.flags, 'key-out');
      const domainHint = requireFlag(args.flags, 'domain-hint');
      return printResult(
        await createCommand({
          sources,
          sign: args.flags['sign'] === true,
          json: args.flags['json'] === true,
          ...(name !== undefined ? { name } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(creatorDid !== undefined ? { creatorDid } : {}),
          ...(domain !== undefined ? { domain } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(out !== undefined ? { out } : {}),
          ...(signerDid !== undefined ? { signerDid } : {}),
          ...(keyOut !== undefined ? { keyOut } : {}),
          ...(domainHint !== undefined ? { domainHint } : {}),
        }),
      );
    },
  });
}
