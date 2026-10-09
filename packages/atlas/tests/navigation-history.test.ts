import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NavigationHistory } from '../src/navigation-history.js'
import type { CameraSnapshot } from '../src/types.js'

function snap(altitude: number): CameraSnapshot {
  return { position: { x: 0, y: 0 }, altitude, focusId: null, timestamp: altitude }
}

describe('NavigationHistory', () => {
  it('starts empty and reports no back/forward available', () => {
    const history = new NavigationHistory()
    assert.equal(history.canGoBack(), false)
    assert.equal(history.canGoForward(), false)
    assert.equal(history.current(), null)
  })

  it('current() reflects the most recently pushed snapshot', () => {
    const history = new NavigationHistory()
    history.push(snap(1))
    history.push(snap(2))
    assert.equal(history.current()?.altitude, 2)
  })

  it('goBack() moves to the previous snapshot and enables goForward()', () => {
    const history = new NavigationHistory()
    history.push(snap(1))
    history.push(snap(2))
    history.push(snap(3))
    const back = history.goBack()
    assert.equal(back?.altitude, 2)
    assert.equal(history.canGoForward(), true)
  })

  it('goForward() restores what goBack() undid', () => {
    const history = new NavigationHistory()
    history.push(snap(1))
    history.push(snap(2))
    history.goBack()
    const forward = history.goForward()
    assert.equal(forward?.altitude, 2)
    assert.equal(history.canGoForward(), false)
  })

  it('a new push clears the forward (redo) stack', () => {
    const history = new NavigationHistory()
    history.push(snap(1))
    history.push(snap(2))
    history.goBack()
    history.push(snap(9))
    assert.equal(history.canGoForward(), false)
    assert.equal(history.current()?.altitude, 9)
  })

  it('respects a configured history limit', () => {
    const history = new NavigationHistory({ limit: 3 })
    for (let i = 0; i < 10; i++) history.push(snap(i))
    assert.equal(history.trail().length, 3)
    assert.equal(history.trail()[0]?.altitude, 7)
    assert.equal(history.current()?.altitude, 9)
  })

  it('goBack() with only one entry returns null (nothing before the start)', () => {
    const history = new NavigationHistory()
    history.push(snap(1))
    assert.equal(history.goBack(), null)
  })
})
