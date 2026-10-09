import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NeighborhoodEngine } from '../src/neighborhoods.js'

describe('NeighborhoodEngine', () => {
  it('finds k nearest neighbors in distance order', () => {
    const engine = new NeighborhoodEngine()
    engine.place('signal', { x: 0, y: 0 })
    engine.place('relay', { x: 1, y: 0 })
    engine.place('morrow', { x: 5, y: 0 })
    engine.place('atlas', { x: 2, y: 0 })
    const nearest = engine.neighborsOf('signal', 2)
    assert.deepEqual(
      nearest.map((n) => n.id),
      ['relay', 'atlas'],
    )
  })

  it('within() respects the radius boundary inclusively', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.place('b', { x: 3, y: 0 })
    engine.place('c', { x: 10, y: 0 })
    const near = engine.within('a', 3)
    assert.deepEqual(near.map((n) => n.id), ['b'])
  })

  it('clusters transitively-close entities together regardless of insertion order', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.place('b', { x: 1, y: 0 }) // close to a
    engine.place('c', { x: 2, y: 0 }) // close to b, not directly to a — still one cluster
    engine.place('z', { x: 100, y: 100 }) // isolated

    const clusters = engine.clusterByProximity(1.5)
    const sizes = clusters.map((c) => c.members.length).sort((x, y) => x - y)
    assert.deepEqual(sizes, [1, 3])
    const bigCluster = clusters.find((c) => c.members.length === 3)!
    assert.deepEqual([...bigCluster.members].sort(), ['a', 'b', 'c'])
  })

  it('cluster centroid is the average position of its members', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.place('b', { x: 2, y: 0 })
    const clusters = engine.clusterByProximity(5)
    assert.equal(clusters.length, 1)
    assert.deepEqual(clusters[0]!.centroid, { x: 1, y: 0 })
  })

  it('districts are manually declared and queryable both ways', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.place('b', { x: 0, y: 0 })
    engine.defineDistrict('research', ['a', 'b'])
    assert.equal(engine.districtOf('a'), 'research')
    assert.deepEqual([...engine.districtMembers('research')].sort(), ['a', 'b'])
    assert.equal(engine.districtOf('unrelated'), null)
  })

  it('nearestLandmark finds the closest marked landmark to a position', () => {
    const engine = new NeighborhoodEngine()
    engine.place('lighthouse', { x: 10, y: 0 })
    engine.place('shed', { x: 1, y: 0 })
    engine.markLandmark('lighthouse')
    assert.equal(engine.nearestLandmark({ x: 9, y: 0 }), 'lighthouse')
    assert.equal(engine.nearestLandmark({ x: 100, y: 100 }), 'lighthouse')
  })

  it('nearestLandmark returns null when no landmarks are marked', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    assert.equal(engine.nearestLandmark({ x: 0, y: 0 }), null)
  })

  it('routeLength sums consecutive stop distances, zero for short routes', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.place('b', { x: 3, y: 0 })
    engine.place('c', { x: 3, y: 4 })
    engine.defineRoute('tour', ['a', 'b', 'c'])
    assert.equal(engine.routeLength('tour'), 7) // 3 + 4
    engine.defineRoute('single', ['a'])
    assert.equal(engine.routeLength('single'), 0)
    assert.equal(engine.routeLength('never-defined'), 0)
  })

  it('remove() clears a position, its landmark status, and district membership', () => {
    const engine = new NeighborhoodEngine()
    engine.place('a', { x: 0, y: 0 })
    engine.markLandmark('a')
    engine.defineDistrict('d', ['a'])
    engine.remove('a')
    assert.equal(engine.positionOf('a'), undefined)
    assert.equal(engine.isLandmark('a'), false)
    assert.equal(engine.districtOf('a'), null)
  })
})
