import type { CapabilityId } from '../capability-types.js';
import type { PromptTemplate } from './prompt-template.js';
/**
 * Holds every registered prompt version per capability and resolves
 * "the version to use" for a call — either the registry's configured
 * default (normally the newest) or an explicit version a caller pins to
 * (for A/B testing a prompt change, or for deterministic-replay tests
 * that must keep matching a fixture recorded against an older version).
 * Never silently falls back to a different version than requested — an
 * unregistered version is `AI_PROMPT_NOT_FOUND`, not "closest match."
 */
export declare class PromptRegistry {
    private readonly templates;
    private readonly defaultVersion;
    register<TInput>(template: PromptTemplate<TInput>, options?: {
        readonly isDefault?: boolean;
    }): void;
    resolve<TInput>(capability: CapabilityId, version?: string): PromptTemplate<TInput>;
    private key;
}
/** A registry pre-populated with this package's own v1 prompts for every capability — the default `AiCapabilityLayer` uses unless a caller supplies its own registry. */
export declare function createDefaultPromptRegistry(): PromptRegistry;
//# sourceMappingURL=prompt-registry.d.ts.map