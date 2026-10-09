import { clamp } from './types.js';
import { Spring, Spring2D } from './internal/motion.js';
import { NavigationHistory } from './navigation-history.js';
import { SpatialMemory } from './spatial-memory.js';
export class Camera {
    altitudeModel;
    history;
    memory;
    positionSpring;
    altitudeSpring;
    focusId = null;
    orbitState = null;
    followState = null;
    listeners = new Set();
    now;
    constructor(options = {}) {
        this.altitudeModel = options.altitudeModel;
        this.history = options.history ?? new NavigationHistory();
        this.memory = options.memory ?? new SpatialMemory();
        this.now = options.now ?? (() => Date.now());
        this.positionSpring = new Spring2D(options.initialPosition ?? { x: 0, y: 0 }, options.spring);
        this.altitudeSpring = new Spring(options.initialAltitude ?? this.altitudeModel?.min ?? 0, options.spring);
        this.history.push(this.snapshot());
    }
    // -- reading state ------------------------------------------------------
    get position() {
        return { x: this.positionSpring.x.value, y: this.positionSpring.y.value };
    }
    get altitude() {
        return this.altitudeSpring.value;
    }
    get focused() {
        return this.focusId;
    }
    /** Whether every underlying spring has settled — i.e. nothing is
     * currently moving. Orbiting and following are never "settled". */
    get isMoving() {
        return !this.positionSpring.settled || !this.altitudeSpring.settled || !!this.orbitState || !!this.followState;
    }
    snapshot() {
        return {
            position: this.position,
            altitude: this.altitude,
            focusId: this.focusId,
            timestamp: this.now(),
        };
    }
    // -- subscribing ----------------------------------------------------------
    /** Be notified on every tick(). Returns an unsubscribe function. */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notify() {
        const snapshot = this.snapshot();
        for (const listener of this.listeners)
            listener(snapshot);
    }
    // -- advancing the simulation ---------------------------------------------
    /** Advance all motion by dtSeconds. The consumer drives the clock —
     * atlas does not assume a browser, a frame rate, or a runtime. A
     * React (or any other) binding is expected to call this once per
     * frame; a test can call it with whatever dt it likes. */
    tick(dtSeconds) {
        if (this.orbitState) {
            const o = this.orbitState;
            o.angle += o.angularSpeed * dtSeconds;
            this.positionSpring.set({
                x: o.center.x + Math.cos(o.angle) * o.radius,
                y: o.center.y + Math.sin(o.angle) * o.radius,
            });
        }
        if (this.followState) {
            this.positionSpring.set(this.followState.getPosition());
        }
        this.positionSpring.tick(dtSeconds);
        this.altitudeSpring.tick(dtSeconds);
        this.notify();
        return this.snapshot();
    }
    // -- movement ---------------------------------------------------------------
    /** Move toward a position in the plane. Cancels orbit/follow. */
    flyTo(position, options = {}) {
        this.cancelAmbientMotion();
        this.positionSpring.set(position);
        if (options.altitude !== undefined) {
            this.altitudeSpring.set(this.clampAltitude(options.altitude));
        }
        if (options.commit ?? true)
            this.commit();
    }
    /** Move to a specific altitude (a level id, if an AltitudeModel is
     * configured, or a raw number). Position is unchanged. */
    zoomTo(altitude, options = {}) {
        const target = typeof altitude === 'string' ? this.resolveLevelId(altitude) : altitude;
        this.altitudeSpring.set(this.clampAltitude(target));
        if (options.commit ?? true)
            this.commit();
    }
    /** Focus on an entity at a position, without necessarily changing
     * altitude. This is "attention", distinct from "depth". */
    focus(entityId, position, options = {}) {
        this.cancelAmbientMotion();
        this.focusId = entityId;
        this.positionSpring.set(position);
        if (options.altitude !== undefined)
            this.altitudeSpring.set(this.clampAltitude(options.altitude));
        this.commit();
    }
    unfocus(options = {}) {
        this.focusId = null;
        if (options.rise && this.altitudeModel) {
            const shallower = this.altitudeModel.shallower(this.altitudeSpring.target);
            if (shallower)
                this.altitudeSpring.set(shallower.order);
        }
        this.commit();
    }
    /** Enter an entity: focus on it and move one level deeper. This is
     * the closest thing atlas has to "opening" something — except
     * nothing opens, the camera simply gets closer. */
    enter(entityId, position) {
        this.cancelAmbientMotion();
        this.focusId = entityId;
        this.positionSpring.set(position);
        if (this.altitudeModel) {
            const deeper = this.altitudeModel.deeper(this.altitudeSpring.target);
            if (deeper)
                this.altitudeSpring.set(deeper.order);
        }
        this.memory.markVisited(entityId);
        this.commit();
    }
    /** Leave the current focus: rise one level shallower and return
     * focus to whatever was focused before, if navigation history knows. */
    leave() {
        this.focusId = null;
        if (this.altitudeModel) {
            const shallower = this.altitudeModel.shallower(this.altitudeSpring.target);
            if (shallower)
                this.altitudeSpring.set(shallower.order);
        }
        this.commit();
    }
    /** Orbit continuously around a center point until another movement
     * command is issued. Used for ambient motion — a camera watching
     * something rather than travelling toward it. */
    orbit(center, options = { radius: 0 }) {
        this.followState = null;
        const currentAngle = Math.atan2(this.position.y - center.y, this.position.x - center.x);
        this.orbitState = {
            center,
            radius: options.radius,
            angularSpeed: options.angularSpeed ?? 0.2,
            angle: Number.isFinite(currentAngle) ? currentAngle : 0,
        };
    }
    /** Softly track a moving position — e.g. an entity that is itself
     * animating — until stopped or overridden by another command. */
    follow(entityId, getPosition) {
        this.orbitState = null;
        this.followState = { entityId, getPosition };
        this.focusId = entityId;
    }
    stopOrbit() {
        this.orbitState = null;
    }
    stopFollow() {
        this.followState = null;
    }
    cancelAmbientMotion() {
        this.orbitState = null;
        this.followState = null;
    }
    // -- memory -------------------------------------------------------------------
    /** Deliberately remember the current place. Returns its id. */
    remember(label = null) {
        return this.memory.remember(this.snapshot(), label, this.now());
    }
    /** Fly back to a remembered place (by id or label). Returns false if
     * nothing matched. */
    restore(idOrLabel) {
        const place = this.memory.recall(idOrLabel);
        if (!place)
            return false;
        this.cancelAmbientMotion();
        this.focusId = place.snapshot.focusId;
        this.positionSpring.set(place.snapshot.position);
        this.altitudeSpring.set(this.clampAltitude(place.snapshot.altitude));
        this.commit();
        return true;
    }
    // -- history --------------------------------------------------------------------
    back() {
        const snapshot = this.history.goBack();
        if (!snapshot)
            return false;
        this.jumpTo(snapshot);
        return true;
    }
    forward() {
        const snapshot = this.history.goForward();
        if (!snapshot)
            return false;
        this.jumpTo(snapshot);
        return true;
    }
    // -- internals ------------------------------------------------------------------
    /** Push the current target state into navigation history. Called
     * automatically by every committing movement method; exposed in
     * case a consumer builds a custom movement command on top of the
     * springs directly. */
    commit() {
        this.history.push({
            position: { x: this.positionSpring.x.target, y: this.positionSpring.y.target },
            altitude: this.altitudeSpring.target,
            focusId: this.focusId,
            timestamp: this.now(),
        });
    }
    jumpTo(snapshot) {
        this.cancelAmbientMotion();
        this.focusId = snapshot.focusId;
        this.positionSpring.set(snapshot.position);
        this.altitudeSpring.set(this.clampAltitude(snapshot.altitude));
        this.notify();
    }
    clampAltitude(order) {
        return this.altitudeModel ? this.altitudeModel.clamp(order) : order;
    }
    resolveLevelId(id) {
        if (!this.altitudeModel) {
            throw new Error(`Camera.zoomTo("${id}") requires an AltitudeModel to resolve level ids.`);
        }
        const level = this.altitudeModel.byId(id);
        if (!level)
            throw new Error(`Unknown altitude level id: "${id}".`);
        return level.order;
    }
}
export function clampToRange(value, min, max) {
    return clamp(value, min, max);
}
//# sourceMappingURL=camera.js.map