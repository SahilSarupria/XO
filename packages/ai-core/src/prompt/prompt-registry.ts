import { AiError, ErrorCode } from '@xo/errors';
import type { CapabilityId } from '../capability-types.js';
import type { PromptTemplate } from './prompt-template.js';
import { entitiesPromptV1, knowledgePromptV1, reasoningPromptV1, capabilitiesPromptV1, decisionGraphPromptV1, constraintsPromptV1 } from './default-prompts.js';

/**
 * Holds every registered prompt version per capability and resolves
 * "the version to use" for a call — either the registry's configured
 * default (normally the newest) or an explicit version a caller pins to
 * (for A/B testing a prompt change, or for deterministic-replay tests
 * that must keep matching a fixture recorded against an older version).
 * Never silently falls back to a different version than requested — an
 * unregistered version is `AI_PROMPT_NOT_FOUND`, not "closest match."
 */
export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate<never>>();
  private readonly defaultVersion = new Map<CapabilityId, string>();

  register<TInput>(template: PromptTemplate<TInput>, options: { readonly isDefault?: boolean } = {}): void {
    this.templates.set(this.key(template.capability, template.version), template as PromptTemplate<never>);
    if (options.isDefault !== false && !this.defaultVersion.has(template.capability)) {
      this.defaultVersion.set(template.capability, template.version);
    } else if (options.isDefault === true) {
      this.defaultVersion.set(template.capability, template.version);
    }
  }

  resolve<TInput>(capability: CapabilityId, version?: string): PromptTemplate<TInput> {
    const resolvedVersion = version ?? this.defaultVersion.get(capability);
    if (resolvedVersion === undefined) {
      throw new AiError(ErrorCode.AI_PROMPT_NOT_FOUND, `No default prompt version registered for capability "${capability}"`);
    }
    const template = this.templates.get(this.key(capability, resolvedVersion));
    if (!template) {
      throw new AiError(ErrorCode.AI_PROMPT_NOT_FOUND, `No prompt registered for capability "${capability}" version "${resolvedVersion}"`);
    }
    return template as unknown as PromptTemplate<TInput>;
  }

  private key(capability: CapabilityId, version: string): string {
    return `${capability}@${version}`;
  }
}

/** A registry pre-populated with this package's own v1 prompts for every capability — the default `AiCapabilityLayer` uses unless a caller supplies its own registry. */
export function createDefaultPromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.register(entitiesPromptV1);
  registry.register(knowledgePromptV1);
  registry.register(reasoningPromptV1);
  registry.register(capabilitiesPromptV1);
  registry.register(decisionGraphPromptV1);
  registry.register(constraintsPromptV1);
  return registry;
}
