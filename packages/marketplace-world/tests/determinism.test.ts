import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectWorld } from '../src/projection.js'
import { serializeWorld } from '../src/serialization.js'
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js'
import type { SourceGraph } from '../src/source-graph.js'

describe('determinism', () => {
  it('projecting the same source graph twice yields byte-identical serialized output', () => {
    const worldA = projectWorld(SAMPLE_GRAPH)
    const worldB = projectWorld(SAMPLE_GRAPH)
    assert.deepEqual(serializeWorld(worldA), serializeWorld(worldB))
  })

  it('reordering the xos and relationships arrays does not change the result', () => {
    const reordered: SourceGraph = {
      xos: [...SAMPLE_GRAPH.xos].reverse(),
      relationships: [...(SAMPLE_GRAPH.relationships ?? [])].reverse(),
    }
    const worldA = projectWorld(SAMPLE_GRAPH)
    const worldB = projectWorld(reordered)
    assert.deepEqual(serializeWorld(worldA), serializeWorld(worldB))
  })

  it('an unchanged source graph produces identical world state across many repeated runs', () => {
    const results = Array.from({ length: 5 }, () => serializeWorld(projectWorld(SAMPLE_GRAPH)))
    for (let i = 1; i < results.length; i++) {
      assert.deepEqual(results[i], results[0])
    }
  })

  it('a single isolated XO lands exactly at the center after normalization', () => {
    const graphA: SourceGraph = { xos: [{ id: 'lonely', name: 'Lonely', kind: 'x', capabilityIds: [] }] }
    const posA = projectWorld(graphA).positions.get('lonely')!
    assert.ok(Math.abs(posA.x - 50) < 0.001 && Math.abs(posA.y - 50) < 0.001)
  })

  it("changing one XO's data changes the serialized world (sanity check against a no-op comparator)", () => {
    const mutated: SourceGraph = {
      xos: SAMPLE_GRAPH.xos.map((xo) => (xo.id === 'signal' ? { ...xo, status: 'Sleeping' } : xo)),
      relationships: SAMPLE_GRAPH.relationships,
    }
    const original = serializeWorld(projectWorld(SAMPLE_GRAPH))
    const changed = serializeWorld(projectWorld(mutated))
    assert.notDeepEqual(original, changed)
  })
})
