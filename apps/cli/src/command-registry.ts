import type { Logger } from '@xo/logger';
import type { ParsedArgs } from './arg-parser.js';

export interface CommandContext {
  readonly logger: Logger;
}

export interface CommandDefinition {
  /** The top-level word a user types (`xo <name> ...`). Must be unique across every subsystem — {@link CommandRegistry.register} throws if two subsystems both try to claim the same name, which is deliberately a hard failure at startup rather than a silent last-registration-wins overwrite. */
  readonly name: string;
  /** Which `commands/<subsystem>/` this command came from — used only to group `--help` output; never affects dispatch. */
  readonly subsystem: string;
  /** A one-line (or few-line) usage string shown in `xo --help`. */
  readonly usage: string;
  /** Handles a fully-parsed invocation and returns (or resolves to) a process exit code. Does its own stdout writing — commands built on `@xo/package-sdk`'s `CommandResult` convention go through {@link printResult} to bridge into this shape. */
  readonly run: (args: ParsedArgs, ctx: CommandContext) => number | Promise<number>;
}

/**
 * This is the entire mechanism behind "commands register themselves":
 * every subsystem (`commands/package/`, `commands/system/`, and — once
 * they exist — `commands/compiler/`, `commands/runtime/`,
 * `commands/registry/`, `commands/benchmark/`, `commands/ai/`) exports a
 * `registerCommands(registry)` function that calls `registry.register(...)`
 * for whatever commands it owns. `index.ts` calls every subsystem's
 * `registerCommands()` once at startup and then dispatches purely by
 * looking a name up in this registry — it never contains a per-command
 * switch statement, and adding a new command to an existing subsystem
 * (or a new subsystem with commands of its own) never requires touching
 * `index.ts`'s dispatch logic, only that subsystem's own
 * `registerCommands()`.
 *
 * `declareSubsystem` exists so a subsystem with zero commands today
 * (compiler/runtime/registry/benchmark/ai, as of this writing) can still
 * announce itself in `--help` output — the CLI's shape as "the single
 * entry point for the whole ecosystem" should be visible even before
 * every subsystem has commands to register.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly subsystems = new Map<string, string>();

  register(command: CommandDefinition): void {
    if (this.commands.has(command.name)) {
      throw new Error(
        `Command "${command.name}" is already registered (subsystem "${this.commands.get(command.name)!.subsystem}") — command names must be unique across every subsystem's registerCommands().`,
      );
    }
    this.commands.set(command.name, command);
    if (!this.subsystems.has(command.subsystem)) this.subsystems.set(command.subsystem, '');
  }

  /** Announces a subsystem even if it registers no commands (yet) — see the class docstring. Safe to call before or after that subsystem's `register()` calls; a description set here is never overwritten by `register()`. */
  declareSubsystem(name: string, description: string): void {
    this.subsystems.set(name, description);
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  /** Every registered command, grouped by subsystem, in the order subsystems were first seen. */
  listBySubsystem(): ReadonlyMap<string, { readonly description: string; readonly commands: readonly CommandDefinition[] }> {
    const result = new Map<string, { description: string; commands: CommandDefinition[] }>();
    for (const [subsystem, description] of this.subsystems) {
      result.set(subsystem, { description, commands: [] });
    }
    for (const command of this.commands.values()) {
      const entry = result.get(command.subsystem);
      if (entry) entry.commands.push(command);
    }
    return result;
  }
}
