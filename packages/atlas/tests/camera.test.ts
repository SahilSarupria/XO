import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../src/camera.js'
import { AltitudeModel } from '../src/altitude.js'

function marketplaceAltitudes(): AltitudeModel {
  return new AltitudeModel([
    { id: 'ecosystem', order: 0, label: 'Ecosystem' },
    { id: 'community', order: 1, label: 'Communities' },
    { id: 'experience', order: 2, label: 'Experiences' },
    { id: 'capability', order: 3, label: 'Capabilities' },
    { id: 'workflow', order: 4, label: 'Workflow' },
    { id: 'reasoning', order: 5, label: 'Reasoning' },
    { id: 'memory', order: 6, label: 'Memory' },
    { id: 'execution', order: 7, label: 'Execution' },
  ])
}

function settle(camera: Camera, seconds = 5, step = 1 / 60): void {
  const steps = Math.ceil(seconds / step)
  for (let i = 0; i < steps; i++) camera.tick(step)
}

describe('Camera', () => {
  it('starts at the given initial position and altitude, settled', () => {
    const camera = new Camera({ initialPosition: { x: 3, y: 4 }, initialAltitude: 1 })
    assert.deepEqual(camera.position, { x: 3, y: 4 })
    assert.equal(camera.altitude, 1)
    assert.equal(camera.isMoving, false)
  })

  it('flyTo() moves position through continuous motion, never an instant jump', () => {
    const camera = new Camera({ initialPosition: { x: 0, y: 0 } })
    camera.flyTo({ x: 100, y: 0 })
    assert.equal(camera.isMoving, true)
    camera.tick(1 / 60)
    // after a single 60fps tick it should have moved only a little, not all the way
    assert.ok(camera.position.x > 0 && camera.position.x < 20, `got ${camera.position.x}`)
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 100) < 0.1)
    assert.equal(camera.isMoving, false)
  })

  it('zoomTo() accepts a raw altitude number', () => {
    const camera = new Camera()
    camera.zoomTo(4)
    settle(camera)
    assert.ok(Math.abs(camera.altitude - 4) < 0.01)
  })

  it('zoomTo() resolves a level id against a configured AltitudeModel', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes() })
    camera.zoomTo('reasoning')
    settle(camera)
    assert.ok(Math.abs(camera.altitude - 5) < 0.01)
  })

  it('zoomTo() with a level id throws without an AltitudeModel', () => {
    const camera = new Camera()
    assert.throws(() => camera.zoomTo('reasoning'))
  })

  it('zoomTo() clamps to the configured altitude range', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes() })
    camera.zoomTo(999)
    settle(camera)
    assert.ok(Math.abs(camera.altitude - 7) < 0.01)
  })

  it('focus() sets the focused entity and moves toward its position', () => {
    const camera = new Camera()
    camera.focus('forge', { x: 5, y: 5 })
    assert.equal(camera.focused, 'forge')
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 5) < 0.1)
  })

  it('unfocus() clears focus and optionally rises a level', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes(), initialAltitude: 3 })
    camera.focus('forge', { x: 0, y: 0 })
    camera.unfocus({ rise: true })
    settle(camera)
    assert.equal(camera.focused, null)
    assert.ok(Math.abs(camera.altitude - 2) < 0.01)
  })

  it('enter() focuses and moves one configured level deeper', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes(), initialAltitude: 2 })
    camera.enter('forge', { x: 1, y: 1 })
    settle(camera)
    assert.equal(camera.focused, 'forge')
    assert.ok(Math.abs(camera.altitude - 3) < 0.01)
    assert.equal(camera.memory.hasVisited('forge'), true)
  })

  it('enter() at the deepest level does not go out of range', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes(), initialAltitude: 7 })
    camera.enter('leaf', { x: 0, y: 0 })
    settle(camera)
    assert.ok(Math.abs(camera.altitude - 7) < 0.01)
  })

  it('leave() clears focus and rises one configured level', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes(), initialAltitude: 2 })
    camera.enter('forge', { x: 1, y: 1 })
    settle(camera)
    camera.leave()
    settle(camera)
    assert.equal(camera.focused, null)
    assert.ok(Math.abs(camera.altitude - 2) < 0.01)
  })

  it('orbit() keeps the camera continuously moving around a center and never settles', () => {
    const camera = new Camera({ initialPosition: { x: 10, y: 0 } })
    camera.orbit({ x: 0, y: 0 }, { radius: 10, angularSpeed: 1 })
    const before = { ...camera.position }
    for (let i = 0; i < 30; i++) camera.tick(1 / 60)
    const after = camera.position
    assert.notDeepEqual(before, after)
    assert.equal(camera.isMoving, true)
    // stays (approximately) at the configured radius from the center
    const radius = Math.hypot(after.x, after.y)
    assert.ok(Math.abs(radius - 10) < 1, `expected radius ~10, got ${radius}`)
  })

  it('a subsequent flyTo() cancels an active orbit', () => {
    const camera = new Camera()
    camera.orbit({ x: 0, y: 0 }, { radius: 5 })
    camera.flyTo({ x: 1, y: 1 })
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 1) < 0.1)
    assert.ok(Math.abs(camera.position.y - 1) < 0.1)
  })

  it('follow() tracks a moving target position each tick', () => {
    const camera = new Camera({ initialPosition: { x: 0, y: 0 } })
    let targetX = 0
    camera.follow('drifter', () => ({ x: targetX, y: 0 }))
    for (let i = 0; i < 10; i++) {
      targetX += 1
      camera.tick(1 / 60)
    }
    assert.equal(camera.focused, 'drifter')
    assert.ok(camera.position.x > 0)
  })

  it('stopOrbit() and stopFollow() end ambient motion so the camera can settle', () => {
    const camera = new Camera()
    camera.orbit({ x: 0, y: 0 }, { radius: 1 })
    camera.stopOrbit()
    settle(camera)
    assert.equal(camera.isMoving, false)
  })

  it('remember() and restore() round-trip a place', () => {
    const camera = new Camera({ altitudeModel: marketplaceAltitudes() })
    camera.enter('forge', { x: 7, y: 7 })
    settle(camera)
    const placeId = camera.remember('forge interior')
    camera.leave()
    settle(camera)
    assert.notEqual(camera.focused, 'forge')

    const restored = camera.restore(placeId)
    assert.equal(restored, true)
    settle(camera)
    assert.equal(camera.focused, 'forge')
    assert.ok(Math.abs(camera.position.x - 7) < 0.1)
  })

  it('restore() returns false for an unknown place', () => {
    const camera = new Camera()
    assert.equal(camera.restore('nope'), false)
  })

  it('back() and forward() move through navigation history without a page ever changing', () => {
    const camera = new Camera()
    camera.flyTo({ x: 1, y: 0 })
    settle(camera)
    camera.flyTo({ x: 2, y: 0 })
    settle(camera)
    camera.flyTo({ x: 3, y: 0 })
    settle(camera)

    assert.equal(camera.back(), true)
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 2) < 0.1)

    assert.equal(camera.back(), true)
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 1) < 0.1)

    assert.equal(camera.forward(), true)
    settle(camera)
    assert.ok(Math.abs(camera.position.x - 2) < 0.1)
  })

  it('subscribe() notifies listeners on every tick and unsubscribe stops it', () => {
    const camera = new Camera()
    let calls = 0
    const unsubscribe = camera.subscribe(() => {
      calls += 1
    })
    camera.tick(1 / 60)
    camera.tick(1 / 60)
    unsubscribe()
    camera.tick(1 / 60)
    assert.equal(calls, 2)
  })

  it('is deterministic given an injected clock and fixed tick sequence', () => {
    let clock = 0
    const now = () => clock
    const a = new Camera({ now })
    const b = new Camera({ now })
    a.flyTo({ x: 50, y: -20 })
    b.flyTo({ x: 50, y: -20 })
    const trailA: number[] = []
    const trailB: number[] = []
    for (let i = 0; i < 40; i++) {
      clock += 16
      trailA.push(a.tick(0.016).position.x)
    }
    clock = 0
    for (let i = 0; i < 40; i++) {
      clock += 16
      trailB.push(b.tick(0.016).position.x)
    }
    assert.deepEqual(trailA, trailB)
  })
})
