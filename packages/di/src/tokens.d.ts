/**
 * A `Token<T>` is a unique, type-carrying key for registering/resolving a
 * dependency. The generic parameter never exists at runtime (TS erases it)
 * but lets `container.resolve(token)` return the right type without casts.
 */
export interface Token<T> {
    readonly id: symbol;
    readonly description: string;
    /** Phantom property — never assigned, only read by the type checker. */
    readonly __type?: T;
}
export declare function createToken<T>(description: string): Token<T>;
//# sourceMappingURL=tokens.d.ts.map