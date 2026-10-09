/**
 * Internal physical-motion primitive.
 *
 * Not exported from the package. Everything the camera moves —
 * position, altitude, orbit angle — moves through a critically-ish
 * damped spring rather than an eased tween. Springs never produce an
 * abrupt transition: a new target simply becomes a new resting place
 * for motion that is already underway, so movement composes cleanly
 * even when the destination changes mid-flight.
 *
 * Springs are deterministic: the same sequence of tick(dt) calls
 * against the same target always produces the same trajectory. That
 * determinism is what makes the camera testable without a real clock.
 */

export interface SpringConfig {
  /** How strongly the spring pulls toward its target. Higher = snappier. */
  stiffness?: number
  /** How strongly motion is resisted. Higher = less overshoot. */
  damping?: number
  /** Inertia. Higher = slower to respond. */
  mass?: number
  /** Velocity below which the spring is considered at rest. */
  restVelocity?: number
  /** Distance from target below which the spring is considered at rest. */
  restDelta?: number
}

const DEFAULTS: Required<SpringConfig> = {
  stiffness: 170,
  damping: 26,
  mass: 1,
  restVelocity: 0.001,
  restDelta: 0.001,
}

/** Fixed sub-step used to integrate the spring. Keeps the simulation
 * stable and reproducible even when tick() is called with a large or
 * irregular dt (e.g. a slow frame, or a test advancing time in bulk). */
const SUBSTEP_SECONDS = 1 / 120

export class Spring {
  value: number
  velocity: number
  target: number

  private readonly config: Required<SpringConfig>

  constructor(initial: number, config: SpringConfig = {}) {
    this.value = initial
    this.target = initial
    this.velocity = 0
    this.config = { ...DEFAULTS, ...config }
  }

  /** Give the spring a new resting place without moving the value. */
  set(target: number): void {
    this.target = target
  }

  /** Move the value (and its target) instantly, killing velocity. Used
   * for restoring a remembered position, never for ordinary navigation. */
  jump(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  /** Advance the simulation by dtSeconds. Returns the new value. */
  tick(dtSeconds: number): number {
    if (dtSeconds <= 0) return this.value
    const steps = Math.max(1, Math.ceil(dtSeconds / SUBSTEP_SECONDS))
    const stepDt = dtSeconds / steps
    const { stiffness, damping, mass } = this.config
    for (let i = 0; i < steps; i++) {
      const springForce = -stiffness * (this.value - this.target)
      const dampingForce = -damping * this.velocity
      const acceleration = (springForce + dampingForce) / mass
      this.velocity += acceleration * stepDt
      this.value += this.velocity * stepDt
    }
    return this.value
  }

  get settled(): boolean {
    return (
      Math.abs(this.velocity) < this.config.restVelocity &&
      Math.abs(this.target - this.value) < this.config.restDelta
    )
  }
}

/** A pair of springs moving together as a single point in the plane. */
export class Spring2D {
  readonly x: Spring
  readonly y: Spring

  constructor(initial: { x: number; y: number }, config: SpringConfig = {}) {
    this.x = new Spring(initial.x, config)
    this.y = new Spring(initial.y, config)
  }

  set(target: { x: number; y: number }): void {
    this.x.set(target.x)
    this.y.set(target.y)
  }

  jump(value: { x: number; y: number }): void {
    this.x.jump(value.x)
    this.y.jump(value.y)
  }

  tick(dtSeconds: number): { x: number; y: number } {
    return { x: this.x.tick(dtSeconds), y: this.y.tick(dtSeconds) }
  }

  get settled(): boolean {
    return this.x.settled && this.y.settled
  }
}
