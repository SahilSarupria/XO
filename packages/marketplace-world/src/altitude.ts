import { AltitudeModel, type AltitudeLevel } from '@xo/atlas'

/**
 * The marketplace depth model.
 *
 * Not every level implies UI — some are here purely to describe what
 * information *becomes available*, leaving whether or how to render
 * it entirely to the consumer. That's the point of separating this
 * from Atlas's SemanticZoomRegistry (see semantic.ts): this module
 * says *when something exists to know*; semantic.ts says *how visible
 * it currently is*.
 */
export const MARKETPLACE_ALTITUDE_LEVELS: readonly AltitudeLevel[] = [
  {
    id: 'ecosystem',
    order: 0,
    label: 'Ecosystem',
    description: 'The whole marketplace. Only aggregate shape — communities as clusters — is meaningful here.',
  },
  {
    id: 'community',
    order: 1,
    label: 'Community',
    description: 'Communities are distinguishable; member XOs begin to resolve as individual points.',
  },
  {
    id: 'experience',
    order: 2,
    label: 'Experience',
    description: 'An XO\u2019s identity, current signal (status), and relationships are fully available.',
  },
  {
    id: 'capability',
    order: 3,
    label: 'Capability',
    description: 'What the XO can do becomes available.',
  },
  {
    id: 'workflow',
    order: 4,
    label: 'Workflow',
    description: 'How the XO carries out its capabilities becomes available.',
  },
  {
    id: 'reasoning',
    order: 5,
    label: 'Reasoning',
    description:
      'How the XO currently approaches a task becomes available. No runtime exists yet to populate this with real data \u2014 see README.md.',
  },
  {
    id: 'memory',
    order: 6,
    label: 'Memory',
    description:
      'What the XO currently holds in memory becomes available. Same caveat as Reasoning: no runtime backs this yet.',
  },
  {
    id: 'execution',
    order: 7,
    label: 'Execution',
    description: 'The XO\u2019s live, in-progress work becomes available. Requires a runtime this repository does not yet have.',
  },
]

export function createMarketplaceAltitudeModel(): AltitudeModel {
  return new AltitudeModel(MARKETPLACE_ALTITUDE_LEVELS)
}
