import type { Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import type { PermissionRequirement } from '@xo/permissions';
/**
 * The Runtime capability authority layer.
 *
 * `@xo/types`' `CapabilityDeclaration` (see `xo-capability.ts`) is a
 * package's own *claim*, written into `manifest.json` by whoever
 * published the `.xo` — descriptive metadata a `CapabilityNegotiator`
 * ranks and an `ExecutionPipeline` uses to assemble a prompt for an AI
 * `ModelProvider` to answer. Nothing in that path ever runs native code;
 * "executing" a manifest-declared capability always means "an LLM
 * completes a prompt built from this package's retrieved components."
 *
 * `RuntimeCapabilityDeclaration` is a different, deliberately separate
 * concept: an explicit statement, made only by whoever is *running* this
 * Runtime process (never by a package's manifest, never inferred from
 * `knowledge_graph.json` or any other semantic/compiler-produced data),
 * that a specific native function is the authoritative implementation of
 * a capability id. This is what actually grants execution authority.
 * Presence of a same-named `CapabilityDeclaration` in some mounted
 * package's manifest — or of a `capability`-kind node in that package's
 * `knowledge_graph.json` (see `EXPERIENCE_COMPILER.md` §3.2 / the
 * compiler's Packager) — implies nothing about whether a
 * `RuntimeCapabilityDeclaration` exists for that id. The two id spaces
 * happen to share a string type; they are not the same registry, and
 * nothing in this module ever consults the other one.
 *
 * Required permissions are deliberately *not* a field here — see
 * `RuntimeCapabilityRegistry.register`'s doc comment for why: they go
 * through `@xo/permissions`' existing `CapabilityPermissionRegistry`,
 * the mechanism that package's own doc comment already describes as
 * being for exactly this case ("capabilities that want to declare their
 * requirements in code ... rather than through a package manifest").
 * Duplicating that as a field here would create two sources of truth for
 * the same fact.
 */
/** A minimal, non-inventive "what shape of data this side expects/produces" contract — a human-readable description plus an optional reference to wherever the real schema lives (a JSON Schema id, an OpenAPI operation, a TypeScript type name — this module does not parse or enforce it, only carries the reference). Mirrors the same `schemaRef`-as-opaque-string convention already used at the semantic layer (XOIR's `capability` node payload), without importing that type — see this file's top doc comment on why the two must stay independent even where their shape rhymes. */
export interface RuntimeCapabilityContract {
    readonly description: string;
    readonly schemaRef?: string;
}
/** The actual native implementation. Runs only after `RuntimeCapabilityExecutor` has resolved the declaration and confirmed every required permission is granted — see that class. Returns a `Result` rather than throwing so a handler's own business-logic failures (as opposed to it being missing/misconfigured) are ordinary, typed outcomes; a handler that does throw is still caught and reported, never crashes the caller (see `RuntimeCapabilityExecutor.execute`). */
export type RuntimeCapabilityHandler = (input: unknown) => Promise<Result<unknown, RuntimeError>>;
export interface RuntimeCapabilityDeclaration {
    /** Same id-space convention as `CapabilityDeclaration.id` (a plain, host-chosen string) — not required to match one, and matching one confers no special meaning: this id is only ever looked up in `RuntimeCapabilityRegistry`, never cross-referenced against `CapabilityRegistry`. */
    readonly capabilityId: string;
    readonly inputContract: RuntimeCapabilityContract;
    readonly outputContract: RuntimeCapabilityContract;
    readonly handler: RuntimeCapabilityHandler;
    /** Optional — a native handler's own release version, independent of any package version (there may be no package at all backing this capability). Omitted when the host has no versioning scheme for its own built-in handlers. */
    readonly version?: string;
}
/** Convenience bundle for `RuntimeCapabilityRegistry.register`'s permission-registration side effect — see that method. Not stored on `RuntimeCapabilityDeclaration` itself, for the reason given in this file's top doc comment. */
export interface RuntimeCapabilityRegistration {
    readonly declaration: RuntimeCapabilityDeclaration;
    readonly requiredPermissions?: readonly PermissionRequirement[];
}
//# sourceMappingURL=runtime-capability-declaration.d.ts.map