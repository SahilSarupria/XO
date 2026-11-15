import type { CommandRegistry } from '../../command-registry.js';
import { printResult } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { KNOWLEDGE_USAGE, knowledgeCommand } from './knowledge.js';

/** PX-4 — the Business Knowledge Base: propose compiled knowledge, approve or reject it, read pinned states. */
export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem('knowledge', 'governed business knowledge: change sets, states, retrieval, domain packs');
  registry.register({
    name: 'knowledge',
    subsystem: 'knowledge',
    usage: `${KNOWLEDGE_USAGE}\n                                         Propose compiled knowledge, approve or reject it, and read pinned knowledge states`,
    run: async (args) => {
      const [action, ...rest] = args.positionals;
      const reason = requireFlag(args.flags, 'reason');
      const state = requireFlag(args.flags, 'state');
      return printResult(
        await knowledgeCommand({
          action: action ?? '',
          args: rest,
          kbDir: requireFlag(args.flags, 'kb') ?? '.xo/knowledge',
          tenant: requireFlag(args.flags, 'tenant') ?? 'local',
          json: args.flags['json'] === true,
          ...(reason !== undefined ? { reason } : {}),
          ...(state !== undefined ? { state } : {}),
        }),
      );
    },
  });
}
