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
export class NavigationHistory {
    past = [];
    future = [];
    limit;
    constructor(options = {}) {
        this.limit = options.limit ?? 200;
    }
    /** Record a committed move. Call this after the camera settles on a
     * new snapshot, not on every intermediate tick. Clears any redo
     * stack, matching ordinary back/forward semantics. */
    push(snapshot) {
        this.past.push(snapshot);
        if (this.past.length > this.limit)
            this.past.shift();
        this.future.length = 0;
    }
    canGoBack() {
        return this.past.length > 1;
    }
    canGoForward() {
        return this.future.length > 0;
    }
    /** Pop the current snapshot and return the one before it, or null if
     * there's nowhere to go. Pushes the popped snapshot onto the redo
     * stack so goForward() can restore it. */
    goBack() {
        if (!this.canGoBack())
            return null;
        const current = this.past.pop();
        this.future.push(current);
        return this.past[this.past.length - 1];
    }
    goForward() {
        if (!this.canGoForward())
            return null;
        const next = this.future.pop();
        this.past.push(next);
        return next;
    }
    current() {
        return this.past.length > 0 ? this.past[this.past.length - 1] : null;
    }
    /** The full path taken so far, oldest first. */
    trail() {
        return this.past;
    }
    clear() {
        this.past.length = 0;
        this.future.length = 0;
    }
}
//# sourceMappingURL=navigation-history.js.map