import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Spring } from '../src/internal/motion.js'

describe('Spring', () => {
  it('starts at rest at its initial value', () => {
    const spring = new Spring(5)
    assert.equal(spring.value, 5)
    assert.equal(spring.target, 5)
    assert.equal(spring.settled, true)
  })

  it('moves toward a new target over time without overshooting to infinity', () => {
    const spring = new Spring(0)
    spring.set(10)
    for (let i = 0; i < 300; i++) spring.tick(1 / 60)
    assert.ok(Math.abs(spring.value - 10) < 0.01, `expected convergence near 10, got ${spring.value}`)
    assert.equal(spring.settled, true)
  })

  it('is deterministic: identical tick sequences produce identical trajectories', () => {
    const a = new Spring(0)
    const b = new Spring(0)
    a.set(42)
    b.set(42)
    const trajectoryA: number[] = []
    const trajectoryB: number[] = []
    for (let i = 0; i < 50; i++) {
      trajectoryA.push(a.tick(1 / 60))
      trajectoryB.push(b.tick(1 / 60))
    }
    assert.deepEqual(trajectoryA, trajectoryB)
  })

  it('never abruptly jumps when the target changes mid-flight (bounded step size)', () => {
    const spring = new Spring(0)
    spring.set(100)
    let previous = spring.value
    let maxStep = 0
    for (let i = 0; i < 120; i++) {
      if (i === 40) spring.set(-50) // redirect mid-flight
      const next = spring.tick(1 / 60)
      maxStep = Math.max(maxStep, Math.abs(next - previous))
      previous = next
    }
    // No single 1/60s tick should move the value by anywhere near the
    // full distance travelled (150 units) — motion is continuous, not a cut.
    assert.ok(maxStep < 20, `expected small per-tick steps, got a step of ${maxStep}`)
  })

  it('jump() moves instantly and kills velocity', () => {
    const spring = new Spring(0)
    spring.set(100)
    spring.tick(1 / 60)
    spring.jump(7)
    assert.equal(spring.value, 7)
    assert.equal(spring.target, 7)
    assert.equal(spring.velocity, 0)
    assert.equal(spring.settled, true)
  })

  it('a zero or negative dt does not move the value', () => {
    const spring = new Spring(3)
    spring.set(9)
    const before = spring.value
    spring.tick(0)
    spring.tick(-1)
    assert.equal(spring.value, before)
  })
})
