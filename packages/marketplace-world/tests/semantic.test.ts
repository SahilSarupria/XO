import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectWorld } from '../src/projection.js'
import { buildMarketplaceSemanticZoom, emergenceForXO, visibleFields } from '../src/semantic.js'
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js'

describe('marketplace semantic zoom', () => {
  it('identity is fully visible by altitude 2 (Experience), before capabilities or workflows', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const registry = buildMarketplaceSemanticZoom(world)
    const states = emergenceForXO(registry, 'signal', 2)
    const identity = states.find((s) => s.data?.field === 'identity')!
    const capabilities = states.find((s) => s.data?.field === 'capabilities')!
    assert.equal(identity.visibility, 1)
    assert.equal(capabilities.visibility, 0)
  })

  it('capabilities and workflows emerge progressively deeper than identity', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const registry = buildMarketplaceSemanticZoom(world)
    const atCapabilityDepth = emergenceForXO(registry, 'signal', 3)
    assert.equal(atCapabilityDepth.find((s) => s.data?.field === 'capabilities')?.visibility, 1)
    assert.equal(atCapabilityDepth.find((s) => s.data?.field === 'workflows')?.visibility, 0)
  })

  it('reasoning, memory, and execution only emerge at the deepest altitudes', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const registry = buildMarketplaceSemanticZoom(world)
    const shallow = emergenceForXO(registry, 'signal', 2)
    for (const field of ['reasoning', 'memory', 'execution']) {
      assert.equal(shallow.find((s) => s.data?.field === field)?.visibility, 0)
    }
    const deepest = emergenceForXO(registry, 'signal', 7)
    for (const field of ['reasoning', 'memory', 'execution']) {
      assert.ok((deepest.find((s) => s.data?.field === field)?.visibility ?? 0) > 0)
    }
  })

  it('visibleFields() reports across every XO in the world, not just one', () => {
    const world = projectWorld(SAMPLE_GRAPH)
    const registry = buildMarketplaceSemanticZoom(world)
    const visible = visibleFields(registry, 2)
    const distinctXOs = new Set(visible.map((s) => s.data?.xoId))
    assert.equal(distinctXOs.size, world.xos.size)
  })
})
