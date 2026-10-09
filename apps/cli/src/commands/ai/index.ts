import type { CommandRegistry } from '../../command-registry.js';

/**
 * No commands registered yet, and no owning package exists in this
 * repository to back them — unlike the other placeholder subsystems
 * (compiler/runtime/registry/benchmark), which at least have a
 * corresponding `@xo/*-core` package already scaffolded, "ai" has no
 * concrete scope defined anywhere in `SPECIFICATION.md` or this repo as
 * of this writing. Declared here only so the subsystem list this CLI was
 * asked to structure around is complete and visible in `--help`; what
 * commands (if any) eventually belong here is an open question for
 * whichever team ends up owning it, not something this change decides.
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem('ai', 'No owning package defined yet — no commands.');
}
