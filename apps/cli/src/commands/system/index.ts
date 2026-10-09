import type { CommandRegistry } from '../../command-registry.js';
import { versionCommand } from './version.js';
import { doctorCommand } from './doctor.js';
import { configShowCommand } from './config-show.js';

/** Registers the CLI's own environment/meta commands — not backed by any `@xo/*` subsystem package, just facts about the CLI itself and its environment. */
export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'version',
    subsystem: 'system',
    usage: 'xo version                              Print the CLI version',
    run: () => {
      process.stdout.write(`${versionCommand()}\n`);
      return 0;
    },
  });

  registry.register({
    name: 'doctor',
    subsystem: 'system',
    usage: 'xo doctor                               Check the local environment',
    run: () => {
      const checks = doctorCommand();
      for (const check of checks) process.stdout.write(`${check.ok ? 'ok' : 'FAIL'}  ${check.name}  ${check.detail}\n`);
      return checks.every((c) => c.ok) ? 0 : 1;
    },
  });

  registry.register({
    name: 'config',
    subsystem: 'system',
    usage: 'xo config show                          Print resolved configuration (secrets masked)',
    run: (args, ctx) => {
      if (args.positionals[0] === 'show') {
        process.stdout.write(`${configShowCommand()}\n`);
        return 0;
      }
      ctx.logger.error('Unknown config subcommand', { positionals: args.positionals });
      process.stdout.write('xo config show\n');
      return 1;
    },
  });
}
