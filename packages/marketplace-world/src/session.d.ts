import type { Camera } from '@xo/atlas';
import type { InstallState, MarketplaceWorld, XOEntity, XOId } from './types.js';
/**
 * Domain events emitted by a MarketplaceWorldSession. Atlas's Camera
 * knows nothing about any of this \u2014 it only ever sees generic
 * enter()/leave() calls. Everything install/state-shaped lives here,
 * per requirement 9.
 */
export type MarketplaceEvent = {
    readonly type: 'xo:entered';
    readonly xoId: XOId;
    readonly timestamp: number;
} | {
    readonly type: 'xo:left';
    readonly xoId: XOId | null;
    readonly timestamp: number;
} | {
    readonly type: 'xo:install-requested';
    readonly xoId: XOId;
    readonly timestamp: number;
} | {
    readonly type: 'xo:installed';
    readonly xoId: XOId;
    readonly timestamp: number;
} | {
    readonly type: 'xo:uninstalled';
    readonly xoId: XOId;
    readonly timestamp: number;
};
export type MarketplaceEventListener = (event: MarketplaceEvent) => void;
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
export declare class MarketplaceWorldSession {
    private readonly world;
    private readonly camera;
    private readonly installStates;
    private readonly listeners;
    private readonly now;
    constructor(world: MarketplaceWorld, camera: Camera, options?: {
        now?: () => number;
    });
    subscribe(listener: MarketplaceEventListener): () => void;
    private emit;
    installStateOf(xoId: XOId): InstallState | undefined;
    /** The XO the world currently has each XO's live state merged in \u2014
     * a convenience so a consumer doesn't have to combine
     * `world.xos.get(id)` with `installStateOf(id)` by hand. */
    entity(xoId: XOId): XOEntity | null;
    /** Translate "entering an XO" into camera motion plus a domain
     * event. camera.enter() itself stays entirely generic. */
    enterXO(xoId: XOId): boolean;
    leaveXO(): void;
    /** Request installation. Validates the state transition and emits
     * both the request and, since this package has no async runtime to
     * wait on, an immediate completion \u2014 a consumer wiring a real
     * install pipeline can instead react to `xo:install-requested` and
     * call `setInstallState` itself once real work finishes. */
    requestInstall(xoId: XOId): boolean;
    /** Explicitly set install state, validated against the transition
     * table. Emits `xo:installed` / `xo:uninstalled` appropriately. */
    setInstallState(xoId: XOId, next: InstallState): boolean;
    /** The philosophy's "installing is staying, not downloading":
     * entering an XO and committing to it in one motion. Consumers free
     * to call enterXO() and requestInstall() separately instead \u2014 this
     * is a convenience, not the only path. */
    commitToXO(xoId: XOId): boolean;
}
//# sourceMappingURL=session.d.ts.map