import type { Token } from './tokens.js';
export type Scope = 'singleton' | 'transient';
export type Factory<T> = (container: Container) => T;
/**
 * A small, explicit IoC container: no decorators, no reflection, no magic
 * constructor-parameter inference. Registration is always an explicit
 * `token -> factory` mapping, which keeps the wiring greppable and keeps
 * this package dependency-free (see docs/adr/0003-dependency-injection.md
 * for why this was hand-rolled instead of adopting a reflect-metadata
 * based container).
 */
export declare class Container {
    private readonly registrations;
    private readonly resolutionStack;
    register<T>(token: Token<T>, factory: Factory<T>, scope?: Scope): void;
    registerValue<T>(token: Token<T>, value: T): void;
    has(token: Token<unknown>): boolean;
    resolve<T>(token: Token<T>): T;
    /** Creates a child container that falls back to this container for anything it doesn't have its own registration for. Useful for per-request scopes. */
    createChild(): Container;
}
//# sourceMappingURL=container.d.ts.map