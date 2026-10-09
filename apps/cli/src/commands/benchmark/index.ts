import type { CommandRegistry } from '../../command-registry.js';
import { printResult } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { benchmarkCompareCommand, benchmarkRunCommand } from './benchmark.js';

const SUBSYSTEM = 'benchmark';

/**
 * `@xo/benchmark` is an evaluation layer, not a semantic feature: these
 * commands only load a suite, run the real pipeline through it, and print
 * / compare reports. All measurement logic lives in `@xo/benchmark`.
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'Evaluate the real XO pipeline against expected semantics/capabilities/workflows/execution (@xo/benchmark).');

  registry.register({
    name: 'benchmark-run',
    subsystem: SUBSYSTEM,
    usage:
      'xo benchmark-run <suite.json> [--baseline <report.json>] [--out <report.json>] [--source-root <dir>]\n' +
      '      [--summary] [--limit <n>] [--json]\n' +
      '                                         Run a benchmark suite through the real pipeline; with --baseline, exit 1 on a regression',
    run: async (args) => {
      const suitePath = args.positionals[0];
      if (suitePath === undefined) {
        process.stdout.write('xo benchmark-run <suite.json> [--baseline <report.json>] [--out <report.json>] [--source-root <dir>] [--summary] [--limit <n>] [--json]\n');
        return 1;
      }
      const baselinePath = requireFlag(args.flags, 'baseline');
      const outPath = requireFlag(args.flags, 'out');
      const sourceRoot = requireFlag(args.flags, 'source-root');
      const limit = requireFlag(args.flags, 'limit');
      return printResult(
        await benchmarkRunCommand({
          suitePath,
          ...(baselinePath !== undefined ? { baselinePath } : {}),
          ...(outPath !== undefined ? { outPath } : {}),
          ...(sourceRoot !== undefined ? { sourceRoot } : {}),
          ...(limit !== undefined && Number.isFinite(Number(limit)) ? { itemLimit: Number(limit) } : {}),
          json: args.flags['json'] === true,
          summaryOnly: args.flags['summary'] === true,
        }),
      );
    },
  });

  registry.register({
    name: 'benchmark-compare',
    subsystem: SUBSYSTEM,
    usage: 'xo benchmark-compare <baseline.json> <current.json> [--json]\n                                         Compare two benchmark reports; exit 1 on a regression',
    run: async (args) => {
      const [baselinePath, currentPath] = args.positionals;
      if (baselinePath === undefined || currentPath === undefined) {
        process.stdout.write('xo benchmark-compare <baseline.json> <current.json> [--json]\n');
        return 1;
      }
      return printResult(await benchmarkCompareCommand({ baselinePath, currentPath, json: args.flags['json'] === true }));
    },
  });
}
