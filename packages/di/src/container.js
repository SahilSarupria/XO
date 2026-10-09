import { DiError, ErrorCode } from '@xo/errors';
/**
 * A small, explicit IoC container: no decorators, no reflection, no magic
 * constructor-parameter inference. Registration is always an explicit
 * `token -> factory` mapping, which keeps the wiring greppable and keeps
 * this package dependency-free (see docs/adr/0003-dependency-injection.md
 * for why this was hand-rolled instead of adopting a reflect-metadata
 * based container).
 */
export class Container {
    registrations = new Map();
    resolutionStack = [];
    register(token, factory, scope = 'singleton') {
        this.registrations.set(token.id, { factory, scope });
    }
    registerValue(token, value) {
        this.register(token, () => value, 'singleton');
    }
    has(token) {
        return this.registrations.has(token.id);
    }
    resolve(token) {
        const registration = this.registrations.get(token.id);
        if (!registration) {
            throw new DiError(ErrorCode.DI_TOKEN_NOT_REGISTERED, `No registration for token "${token.description}"`);
        }
        if (this.resolutionStack.includes(token.id)) {
            const cycle = [...this.resolutionStack, token.id].map((id) => id.description).join(' -> ');
            throw new DiError(ErrorCode.DI_CIRCULAR_DEPENDENCY, `Circular dependency detected: ${cycle}`);
        }
        if (registration.scope === 'singleton' && registration.instance !== undefined) {
            return registration.instance;
        }
        this.resolutionStack.push(token.id);
        try {
            const instance = registration.factory(this);
            if (registration.scope === 'singleton')
                registration.instance = instance;
            return instance;
        }
        finally {
            this.resolutionStack.pop();
        }
    }
    /** Creates a child container that falls back to this container for anything it doesn't have its own registration for. Useful for per-request scopes. */
    createChild() {
        const child = new Container();
        const parent = this;
        const originalResolve = child.resolve.bind(child);
        child.resolve = function (token) {
            if (child.has(token))
                return originalResolve(token);
            return parent.resolve(token);
        };
        return child;
    }
}
//# sourceMappingURL=container.js.map