import type { CameraSnapshot } from './types.js';
/**
 * Navigation history.
 *
 * Every committed camera movement is pushed here automatically. This
 * is distinct from spatial memory: history is involuntary — it is
 * simply a record of where the camera has been — while spatial memory
 * is deliberate, a visitor (or the system) choosing to bookmark
 * somewhere as worth returning to.
 *
 * There is no "different page" to go back to. Going back means the
 * camera flies to an earlier snapshot in the same continuous world.
 */
export declare class NavigationHistory {
    private readonly past;
    private readonly future;
    private readonly limit;
    constructor(options?: {
        limit?: number;
    });
    /** Record a committed move. Call this after the camera settles on a
     * new snapshot, not on every intermediate tick. Clears any redo
     * stack, matching ordinary back/forward semantics. */
    push(snapshot: CameraSnapshot): void;
    canGoBack(): boolean;
    canGoForward(): boolean;
    /** Pop the current snapshot and return the one before it, or null if
     * there's nowhere to go. Pushes the popped snapshot onto the redo
     * stack so goForward() can restore it. */
    goBack(): CameraSnapshot | null;
    goForward(): CameraSnapshot | null;
    current(): CameraSnapshot | null;
    /** The full path taken so far, oldest first. */
    trail(): readonly CameraSnapshot[];
    clear(): void;
}
//# sourceMappingURL=navigation-history.d.ts.map