import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectWorld } from '../src/projection.js'
import { serializeWorld, deserializeWorld } from '../src/serialization.js'
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js'

describe('serialization', () => {
  it('round-trips a projected world without loss', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const serialized = serializeWorld(world)
    const restored = deserializeWorld(serialized)

    assert.deepEqual([...restored.xos.entries()].sort(), [...world.xos.entries()].sort())
    assert.deepEqual([...restored.positions.entries()].sort(), [...world.positions.entries()].sort())
    assert.deepEqual(restored.relationships, world.relationships)
  })

  it('produces JSON-safe plain data (survives JSON.stringify/parse exactly)', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const serialized = serializeWorld(world)
    const roundTripped = JSON.parse(JSON.stringify(serialized))
    assert.deepEqual(roundTripped, serialized)
  })

  it('serialized output is deterministic across repeated calls on the same world', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    assert.deepEqual(serializeWorld(world), serializeWorld(world))
  })

  it('a deserialized world behaves identically to the original for downstream queries', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const restored = deserializeWorld(serializeWorld(world))
    assert.deepEqual(restored.positions.get('signal'), world.positions.get('signal'))
    assert.equal(restored.xos.get('forge')?.name, 'FORGE')
  })
})
