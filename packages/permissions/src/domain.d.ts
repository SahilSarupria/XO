/**
 * The closed set of top-level namespaces a permission id's domain segment
 * (the part before the first `.`) must belong to. Closed deliberately —
 * §18's "no permission string spoofing" requirement means an unrecognized
 * domain must never silently pass validation and reach a policy engine.
 * Adding a new domain is a deliberate, reviewable code change here, not
 * something a package manifest can introduce on its own by just writing a
 * new prefix.
 *
 * The action segment (after the `.`) is intentionally *not* a closed set —
 * see `permission-id.ts` — so new permissions within an existing domain
 * (e.g. a new `filesystem.*` operation) don't require touching this file.
 */
export declare const PERMISSION_DOMAINS: readonly ["filesystem", "network", "process", "environment", "secrets", "clipboard", "device", "ai", "data", "package", "runtime"];
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];
export declare function isPermissionDomain(value: string): value is PermissionDomain;
//# sourceMappingURL=domain.d.ts.map