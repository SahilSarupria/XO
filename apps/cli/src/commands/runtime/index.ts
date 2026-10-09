import type { HostCapability, ModelFamily } from '@xo/types';
import type { CommandRegistry } from '../../command-registry.js';
import { printResult } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { runCommand } from './run.js';
import { workflowCommand } from './workflow.js';
import { demoCommand, isKnownScenario, knownScenarioNames } from './demo.js';
import { resolveProvider } from './provider-factory.js';

const SUBSYSTEM = 'runtime';

/**
 * Registers `run`, backed by `@xo/runtime`'s `Runtime`/`ExecutionEngine`
 * — not `@xo/runtime-core`, which is interface-only (its
 * `Compiler`/`Runtime` interfaces exist to be implemented, and
 * `@xo/runtime` is that implementation; see `runtime.interface.ts`'s own
 * docstring). This module owns the `--provider`/`--model`/`--api-key`/etc.
 * flag shape and turns it into a concrete `@xo/ai-core` `ModelProvider`
 * via `provider-factory.ts`; `run.ts` itself never sees a flag, only a
 * constructed `ModelProvider` and a plain `RunOptions` — the same
 * registration-vs-command split every other subsystem here uses.
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'run',
    subsystem: SUBSYSTEM,
    usage:
      'xo run <capabilityId> --input "<text>" --store <dir>\n' +
      '      [--provider anthropic|openai|azure-openai|gemini|ollama] [--model <id>]\n' +
      '      [--api-key <key>] [--base-url <url>] [--endpoint <url>] [--api-version <v>]\n' +
      '      [--token-budget <n>] [--max-tokens <n>] [--host-family <family>] [--host-capability <cap>]...\n' +
      '      [--grant <permissionId>]... [--json]\n' +
      '                                         Plan and execute a capability against an installed package',
    run: async (args) => {
      const capabilityId = args.positionals[0];
      const input = requireFlag(args.flags, 'input');
      const storeDir = requireFlag(args.flags, 'store');
      if (!capabilityId || !input || !storeDir) {
        process.stdout.write('xo run <capabilityId> --input "<text>" --store <dir> [--provider <id>] [--model <id>] [--json]\n');
        return 1;
      }

      // Provider flags are parsed here (still), but NOT resolved into a
      // constructed ModelProvider yet — that only happens inside
      // runCommand, and only if the capability turns out to need one.
      // See run.ts's doc comment and deterministic-router.ts: resolving
      // a provider is real work (an API key check, for most providers)
      // that a deterministic capability must never pay for or fail on.
      const providerFlag = requireFlag(args.flags, 'provider');
      const apiKeyFlag = requireFlag(args.flags, 'api-key');
      const baseUrlFlag = requireFlag(args.flags, 'base-url');
      const endpointFlag = requireFlag(args.flags, 'endpoint');
      const apiVersionFlag = requireFlag(args.flags, 'api-version');
      const lazyResolveProvider = () =>
        resolveProvider({
          ...(providerFlag !== undefined ? { provider: providerFlag } : {}),
          ...(apiKeyFlag !== undefined ? { apiKey: apiKeyFlag } : {}),
          ...(baseUrlFlag !== undefined ? { baseUrl: baseUrlFlag } : {}),
          ...(endpointFlag !== undefined ? { endpoint: endpointFlag } : {}),
          ...(apiVersionFlag !== undefined ? { apiVersion: apiVersionFlag } : {}),
        });

      const model = requireFlag(args.flags, 'model');
      const query = requireFlag(args.flags, 'query');
      const hostFamily = requireFlag(args.flags, 'host-family') as ModelFamily | undefined;
      const hostCapabilities = args.flagLists['host-capability'] as readonly HostCapability[] | undefined;
      const tokenBudgetFlag = requireFlag(args.flags, 'token-budget');
      const maxTokensFlag = requireFlag(args.flags, 'max-tokens');
      // R3's CLI-level permission grant boundary — see deterministic-router.ts's `buildPermissionManager` doc comment. Repeatable, same mechanism as `--host-capability`.
      const grantedPermissionIds = args.flagLists['grant'] as readonly string[] | undefined;

      return printResult(
        await runCommand(
          {
            capabilityId,
            input,
            storeDir,
            // Just the label the AI-provider flag *would* resolve to —
            // not a construction of the provider itself, so this never
            // triggers an API-key check. Only actually consulted if
            // execution reaches the AI-provider path inside runCommand.
            providerLabel: providerFlag ?? 'anthropic',
            json: args.flags['json'] === true,
            ...(model !== undefined ? { model } : {}),
            ...(query !== undefined ? { query } : {}),
            ...(hostFamily !== undefined ? { hostFamily } : {}),
            ...(hostCapabilities !== undefined && hostCapabilities.length > 0 ? { hostCapabilities } : {}),
            ...(tokenBudgetFlag !== undefined ? { tokenBudget: Number(tokenBudgetFlag) } : {}),
            ...(maxTokensFlag !== undefined ? { maxTokens: Number(maxTokensFlag) } : {}),
            ...(grantedPermissionIds !== undefined && grantedPermissionIds.length > 0 ? { grantedPermissionIds } : {}),
          },
          lazyResolveProvider,
        ),
      );
    },
  });

  registry.register({
    name: 'workflow',
    subsystem: SUBSYSTEM,
    usage:
      'xo workflow <source> [--domain-hint <text>] [--workflow-id <id>] [--workflow-index <n>] [--input <json>] [--json]\n' +
      '                                         Compile a source, compose a real multi-step workflow, and execute it through\n' +
      '                                         the real runtime (composeWorkflows -> prepareCandidateWorkflowForExecution ->\n' +
      '                                         WorkflowExecutor) — never a mock, never a second execution engine.\n' +
      '                                         --input supplies a real trigger payload (e.g. \'{"claim_amount":15000}\')\n' +
      '                                         merged into every bound step\'s structured input; nothing is inferred.\n' +
      '                                         Each step lists its declared inputs/outputs (name, runtime key, type,\n' +
      '                                         derivedFrom) and whether each input is injected from a prior step,\n' +
      '                                         supplied via --input, or missing.',
    run: async (args) => {
      const source = args.positionals[0];
      if (!source) {
        process.stdout.write('xo workflow <source> [--domain-hint <text>] [--workflow-id <id>] [--workflow-index <n>] [--json]\n');
        return 1;
      }
      const domainHint = requireFlag(args.flags, 'domain-hint');
      const workflowId = requireFlag(args.flags, 'workflow-id');
      const workflowIndexFlag = requireFlag(args.flags, 'workflow-index');
      const inputFlag = requireFlag(args.flags, 'input');
      let input: Record<string, unknown> | undefined;
      if (inputFlag !== undefined) {
        try {
          input = JSON.parse(inputFlag);
        } catch (cause) {
          process.stdout.write(`error: --input is not valid JSON: ${(cause as Error).message}\n`);
          return 1;
        }
      }

      return printResult(
        await workflowCommand({
          source,
          ...(domainHint !== undefined ? { domainHint } : {}),
          ...(workflowId !== undefined ? { workflowId } : {}),
          ...(workflowIndexFlag !== undefined ? { workflowIndex: Number(workflowIndexFlag) } : {}),
          ...(input !== undefined ? { input } : {}),
          json: args.flags['json'] === true,
        }),
      );
    },
  });

  registry.register({
    name: 'demo',
    subsystem: SUBSYSTEM,
    usage:
      `xo demo <${knownScenarioNames().join('|')}> [--domain-hint <text>] [--workflow-id <id>] [--workflow-index <n>]\n` +
      '      [--input <json>] [--json]\n' +
      '                                         Run the real golden-path pipeline (same as `xo workflow`) against a\n' +
      '                                         pinned, checked-in fixture, presented as Source / Understanding /\n' +
      '                                         Capability classification / Execution / Final summary sections —\n' +
      '                                         a live-demo-friendly view over the same production compile+compose+\n' +
      '                                         execute pipeline, never a second engine.',
    run: async (args) => {
      const scenario = args.positionals[0];
      if (!scenario || !isKnownScenario(scenario)) {
        process.stdout.write(`xo demo <${knownScenarioNames().join('|')}> [--input <json>] [--json]\n`);
        return 1;
      }
      const domainHint = requireFlag(args.flags, 'domain-hint');
      const workflowId = requireFlag(args.flags, 'workflow-id');
      const workflowIndexFlag = requireFlag(args.flags, 'workflow-index');
      const inputFlag = requireFlag(args.flags, 'input');
      let input: Record<string, unknown> | undefined;
      if (inputFlag !== undefined) {
        try {
          input = JSON.parse(inputFlag);
        } catch (cause) {
          process.stdout.write(`error: --input is not valid JSON: ${(cause as Error).message}\n`);
          return 1;
        }
      }

      return printResult(
        await demoCommand({
          scenario,
          ...(domainHint !== undefined ? { domainHint } : {}),
          ...(workflowId !== undefined ? { workflowId } : {}),
          ...(workflowIndexFlag !== undefined ? { workflowIndex: Number(workflowIndexFlag) } : {}),
          ...(input !== undefined ? { input } : {}),
          json: args.flags['json'] === true,
        }),
      );
    },
  });
}
