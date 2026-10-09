import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '@xo/atlas'
import { projectWorld } from '../src/projection.js'
import { createMarketplaceAltitudeModel } from '../src/altitude.js'
import { MarketplaceWorldSession, type MarketplaceEvent } from '../src/session.js'
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js'

function makeSession() {
  const world = projectWorld(SAMPLE_GRAPH)
  const camera = new Camera({ altitudeModel: createMarketplaceAltitudeModel(), initialAltitude: 2 })
  const session = new MarketplaceWorldSession(world, camera)
  return { world, camera, session }
}

describe('MarketplaceWorldSession', () => {
  it('enterXO() moves the (generic) camera and emits xo:entered — atlas never sees install state', () => {
    const { camera, session } = makeSession()
    const events: MarketplaceEvent[] = []
    session.subscribe((e) => events.push(e))
    const ok = session.enterXO('forge')
    assert.equal(ok, true)
    assert.equal(camera.focused, 'forge')
    assert.equal(camera.memory.hasVisited('forge'), true)
    assert.deepEqual(events.map((e) => e.type), ['xo:entered'])
  })

  it('enterXO() returns false for an unknown XO and does not move the camera', () => {
    const { camera, session } = makeSession()
    const before = camera.focused
    const ok = session.enterXO('does-not-exist')
    assert.equal(ok, false)
    assert.equal(camera.focused, before)
  })

  it('leaveXO() clears focus and emits xo:left with the id that was focused', () => {
    const { session } = makeSession()
    const events: MarketplaceEvent[] = []
    session.enterXO('signal')
    session.subscribe((e) => events.push(e))
    session.leaveXO()
    assert.deepEqual(events, [{ type: 'xo:left', xoId: 'signal', timestamp: events[0]!.timestamp }])
  })

  it('requestInstall() transitions available -> installing and emits the event', () => {
    const { session } = makeSession()
    assert.equal(session.installStateOf('signal'), 'available')
    const events: MarketplaceEvent[] = []
    session.subscribe((e) => events.push(e))
    const ok = session.requestInstall('signal')
    assert.equal(ok, true)
    assert.equal(session.installStateOf('signal'), 'installing')
    assert.deepEqual(events.map((e) => e.type), ['xo:install-requested'])
  })

  it('setInstallState() rejects an invalid transition', () => {
    const { session } = makeSession()
    // available -> installed directly is not a valid transition
    const ok = session.setInstallState('signal', 'installed')
    assert.equal(ok, false)
    assert.equal(session.installStateOf('signal'), 'available')
  })

  it('setInstallState() emits xo:installed on a valid transition into installed', () => {
    const { session } = makeSession()
    const events: MarketplaceEvent[] = []
    session.requestInstall('signal')
    session.subscribe((e) => events.push(e))
    session.setInstallState('signal', 'installed')
    assert.deepEqual(events.map((e) => e.type), ['xo:installed'])
  })

  it('commitToXO() enters and requests install in one motion — "staying, not downloading"', () => {
    const { camera, session } = makeSession()
    const ok = session.commitToXO('atlas')
    assert.equal(ok, true)
    assert.equal(camera.focused, 'atlas')
    assert.equal(session.installStateOf('atlas'), 'installing')
  })

  it('entity() merges live install state into the base XOEntity without mutating the world', () => {
    const { world, session } = makeSession()
    session.requestInstall('morrow')
    const merged = session.entity('morrow')!
    assert.equal(merged.installState, 'installing')
    assert.equal(world.xos.get('morrow')!.installState, 'available') // original untouched
  })
})
