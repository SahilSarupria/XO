const VALID_TRANSITIONS = {
    available: ['installing', 'unavailable'],
    installing: ['installed', 'available'],
    installed: ['available'],
    unavailable: ['available'],
};
/**
 * Wraps a generic Atlas Camera with marketplace-specific behavior:
 * entering an XO is a domain event, and installing is an explicit
 * state machine the consumer can observe \u2014 none of which Atlas is
 * ever told about.
 *
 * This class holds a local, mutable copy of install state per XO
 * (starting from the world's projected state) since install state is
 * exactly the kind of thing that changes without re-running the
 * projection. It does not mutate the MarketplaceWorld it was given.
 */
export class MarketplaceWorldSession {
    world;
    camera;
    installStates = new Map();
    listeners = new Set();
    now;
    constructor(world, camera, options = {}) {
        this.world = world;
        this.camera = camera;
        this.now = options.now ?? (() => Date.now());
        for (const xo of world.xos.values())
            this.installStates.set(xo.id, xo.installState);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
    installStateOf(xoId) {
        return this.installStates.get(xoId);
    }
    /** The XO the world currently has each XO's live state merged in \u2014
     * a convenience so a consumer doesn't have to combine
     * `world.xos.get(id)` with `installStateOf(id)` by hand. */
    entity(xoId) {
        const base = this.world.xos.get(xoId);
        const installState = this.installStates.get(xoId);
        if (!base || !installState)
            return null;
        return { ...base, installState };
    }
    /** Translate "entering an XO" into camera motion plus a domain
     * event. camera.enter() itself stays entirely generic. */
    enterXO(xoId) {
        const position = this.world.positions.get(xoId);
        if (!position || !this.world.xos.has(xoId))
            return false;
        this.camera.enter(xoId, position);
        this.emit({ type: 'xo:entered', xoId, timestamp: this.now() });
        return true;
    }
    leaveXO() {
        const leaving = this.camera.focused;
        this.camera.leave();
        this.emit({ type: 'xo:left', xoId: leaving, timestamp: this.now() });
    }
    /** Request installation. Validates the state transition and emits
     * both the request and, since this package has no async runtime to
     * wait on, an immediate completion \u2014 a consumer wiring a real
     * install pipeline can instead react to `xo:install-requested` and
     * call `setInstallState` itself once real work finishes. */
    requestInstall(xoId) {
        const current = this.installStates.get(xoId);
        if (!current)
            return false;
        if (!VALID_TRANSITIONS[current].includes('installing'))
            return false;
        this.installStates.set(xoId, 'installing');
        this.emit({ type: 'xo:install-requested', xoId, timestamp: this.now() });
        return true;
    }
    /** Explicitly set install state, validated against the transition
     * table. Emits `xo:installed` / `xo:uninstalled` appropriately. */
    setInstallState(xoId, next) {
        const current = this.installStates.get(xoId);
        if (!current)
            return false;
        if (current !== next && !VALID_TRANSITIONS[current].includes(next))
            return false;
        this.installStates.set(xoId, next);
        if (next === 'installed')
            this.emit({ type: 'xo:installed', xoId, timestamp: this.now() });
        if (next === 'available' && current === 'installed') {
            this.emit({ type: 'xo:uninstalled', xoId, timestamp: this.now() });
        }
        return true;
    }
    /** The philosophy's "installing is staying, not downloading":
     * entering an XO and committing to it in one motion. Consumers free
     * to call enterXO() and requestInstall() separately instead \u2014 this
     * is a convenience, not the only path. */
    commitToXO(xoId) {
        const entered = this.enterXO(xoId);
        if (!entered)
            return false;
        return this.requestInstall(xoId);
    }
}
//# sourceMappingURL=session.js.map