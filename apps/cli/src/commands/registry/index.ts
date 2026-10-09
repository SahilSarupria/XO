import type { CommandRegistry } from '../../command-registry.js';
import { printResult, failWith } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { publishCommand } from './publish.js';
import { searchCommand } from './search.js';
import { registryInspectCommand } from './inspect.js';

const SUBSYSTEM = 'registry';

/**
 * Registers every command backed by `@xo/registry`: `publish`, `search`,
 * and `registry inspect`. Mirrors `commands/package/index.ts`'s pattern
 * exactly — this file only ever decides flag/positional shape and calls
 * into the corresponding `*Command()` function, which owns the actual
 * behavior.
 *
 * `publish` and `search` are top-level commands (`xo publish ...`,
 * `xo search ...`), the same flat-namespace convention every other
 * subsystem's commands use (`xo install`, `xo verify`, ...) — see
 * `arg-parser.ts`'s doc comment: `args.command` is always exactly the
 * first token, so there is no built-in notion of a nested subcommand.
 * `registry inspect` is the one exception, by design: it's a single
 * command literally named `registry` whose `run()` dispatches on its own
 * first positional (`inspect` today, room for more later) — "registry
 * inspect" is what the task this package was built from asked for by
 * name, and a lone `registry`-named command is exactly the shape
 * `declareSubsystem`'s doc comment already reserved room for (this
 * subsystem no longer needs the zero-commands placeholder that used to
 * live here).
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'publish',
    subsystem: SUBSYSTEM,
    usage: 'xo publish <archive.xo> --registry <dir>\n                                         Verify and publish a package to a local registry',
    run: async (args) => {
      const archivePath = args.positionals[0];
      const registryDir = requireFlag(args.flags, 'registry');
      if (!archivePath || !registryDir) {
        process.stdout.write('xo publish <archive.xo> --registry <dir>\n');
        return 1;
      }
      return printResult(await publishCommand({ archivePath, registryDir }));
    },
  });

  registry.register({
    name: 'search',
    subsystem: SUBSYSTEM,
    usage: 'xo search <query> --registry <dir>       Search a local registry by name, creator, or capability',
    run: async (args) => {
      const query = args.positionals[0];
      const registryDir = requireFlag(args.flags, 'registry');
      if (!query || !registryDir) {
        process.stdout.write('xo search <query> --registry <dir>\n');
        return 1;
      }
      return printResult(await searchCommand({ query, registryDir }));
    },
  });

  registry.register({
    name: 'registry',
    subsystem: SUBSYSTEM,
    usage: 'xo registry inspect <id> --registry <dir>\n                                         Print a published package plus its recorded benchmark runs',
    run: async (args) => {
      const subcommand = args.positionals[0];
      if (subcommand !== 'inspect') {
        if (subcommand === undefined) {
          process.stdout.write('xo registry inspect <id> --registry <dir>\n');
          return 1;
        }
        return printResult(failWith(`unknown "xo registry" subcommand "${subcommand}" — only "inspect" exists`));
      }
      const id = args.positionals[1];
      const registryDir = requireFlag(args.flags, 'registry');
      if (!id || !registryDir) {
        process.stdout.write('xo registry inspect <id> --registry <dir>\n');
        return 1;
      }
      return printResult(await registryInspectCommand({ id, registryDir }));
    },
  });
}
