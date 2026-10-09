import type { SourceGraph } from '../src/source-graph.js'

/**
 * This fixture is a direct, faithful mapping of the hardcoded
 * `experiences` / `lines` arrays currently inline in app/page.tsx
 * into the SourceGraph contract \u2014 it is not imported from page.tsx
 * (that file exports nothing reusable) and it does not modify
 * page.tsx in any way. It exists purely so this package's tests run
 * against something resembling real content instead of only synthetic
 * data. See README.md for the exact mapping.
 *
 * page.tsx's `lines` array connects nodes by coordinate pairs; here
 * those pairs are resolved back to ids as explicit `dependsOn`
 * relationships.
 */
export const SAMPLE_GRAPH: SourceGraph = {
  xos: [
    {
      id: 'signal',
      name: 'SIGNAL',
      kind: 'Research intelligence',
      status: 'Listening',
      description: 'Turns scattered evidence into a living point of view.',
      capabilityIds: ['research', 'synthesis', 'memory'],
      position: { x: 22, y: 28 },
    },
    {
      id: 'relay',
      name: 'RELAY',
      kind: 'Workflow conductor',
      status: 'Orchestrating',
      description: 'Moves intent through the tools and people that make it real.',
      capabilityIds: ['automations', 'routing', 'teams'],
      position: { x: 49, y: 20 },
    },
    {
      id: 'morrow',
      name: 'MORROW',
      kind: 'Futures studio',
      status: 'Imagining',
      description: 'Makes the shape of tomorrow tangible enough to build.',
      capabilityIds: ['scenarios', 'concepts', 'visuals'],
      position: { x: 76, y: 32 },
    },
    {
      id: 'atlas',
      name: 'ATLAS',
      kind: 'Knowledge system',
      status: 'Indexing',
      description: 'A memory that knows where every useful thing belongs.',
      capabilityIds: ['knowledge', 'recall', 'context'],
      position: { x: 31, y: 64 },
    },
    {
      id: 'forge',
      name: 'FORGE',
      kind: 'Build companion',
      status: 'Compiling',
      description: 'Shapes rough intent into working software, one decision at a time.',
      capabilityIds: ['code', 'review', 'deploy'],
      position: { x: 65, y: 66 },
    },
  ],
  relationships: [
    { fromId: 'signal', toId: 'relay', kind: 'dependsOn' },
    { fromId: 'relay', toId: 'morrow', kind: 'dependsOn' },
    { fromId: 'signal', toId: 'atlas', kind: 'dependsOn' },
    { fromId: 'atlas', toId: 'forge', kind: 'dependsOn' },
    { fromId: 'morrow', toId: 'forge', kind: 'dependsOn' },
    { fromId: 'relay', toId: 'atlas', kind: 'dependsOn' },
  ],
}
