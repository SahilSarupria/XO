import { GraphAnimation } from './GraphAnimation.js';
import type { Easing } from './easing.js';

/**
 * Immutable registry of named, in-flight GraphAnimation instances. Every
 * mutating method returns a new engine instance — nothing here schedules
 * timers or drives itself; the host calls `start`/`stop`/`prune` as part of
 * its own render loop and reads values back out with `get`.
 */
export class GraphAnimationEngine {
  private readonly animations: ReadonlyMap<string, GraphAnimation<unknown>>;

  constructor(animations: ReadonlyMap<string, GraphAnimation<unknown>> = new Map()) {
    this.animations = animations;
  }

  static empty(): GraphAnimationEngine {
    return new GraphAnimationEngine();
  }

  start<T>(id: string, from: T, to: T, durationMs: number, nowMs: number, easing?: Easing, loop = false): GraphAnimationEngine {
    const next = new Map(this.animations);
    next.set(id, GraphAnimation.start(from, to, durationMs, nowMs, easing, loop) as GraphAnimation<unknown>);
    return new GraphAnimationEngine(next);
  }

  stop(id: string): GraphAnimationEngine {
    if (!this.animations.has(id)) return this;
    const next = new Map(this.animations);
    next.delete(id);
    return new GraphAnimationEngine(next);
  }

  get<T = unknown>(id: string): GraphAnimation<T> | undefined {
    return this.animations.get(id) as GraphAnimation<T> | undefined;
  }

  has(id: string): boolean {
    return this.animations.has(id);
  }

  /** Drop non-looping animations that have finished as of `nowMs`, to keep the registry from growing unbounded. */
  prune(nowMs: number): GraphAnimationEngine {
    const next = new Map([...this.animations].filter(([, anim]) => !anim.isComplete(nowMs)));
    if (next.size === this.animations.size) return this;
    return new GraphAnimationEngine(next);
  }

  get activeIds(): readonly string[] {
    return [...this.animations.keys()];
  }

  get size(): number {
    return this.animations.size;
  }
}
