# @xo/atlas

**The interaction engine for XO.**

Not a component library. Not a design system. Not a UI toolkit. Atlas
is the infrastructure behind a single sentence:

> There is only one place. You never navigate away. You only move
> closer, or further.

Marketplace, Studio, Runtime, the compiler, the debugger — every
future XO surface is expected to sit on top of this package. Atlas
itself renders nothing, imports no UI framework, and knows nothing
about experiences, products, or marketplaces. It knows about space,
depth, attention, and memory. Everything domain-specific belongs to
whoever imports it.

---

## Why this exists

Every conventional interface — a marketplace, an IDE, a debugger —
navigates by **distance**: click, load a new place, and the old place
is gone. Atlas replaces that with **depth**: there is exactly one
world, and the only thing that ever changes is how close the camera
is to something in it. "Back" isn't a different URL; it's a lower
altitude in the same continuous space.

That single constraint is the whole idea. Everything in this package
exists to make depth-instead-of-navigation actually implementable,
performant, and testable — not just a nice sentence in a manifesto.

---

## The philosophy, briefly

- **Depth is the only verb.** Movement is always "closer" or
  "further," never "elsewhere."
- **Understanding has layers, not pages.** Zooming into something
  doesn't make it bigger — it makes more of it *true*. That's
  [semantic zoom](#semantic-zoom): meaning changes with depth, and
  nothing pops into existence — everything emerges.
  visible.
- **Nothing abrupt.** Every movement is physical, continuous motion.
  Atlas has no concept of a hard cut.
- **The world remembers.** Where a visitor has been and what they
  bookmarked outlives the current session. See
  [spatial memory](#spatial-memory).
- **Things belong near each other because they're related, not
  categorized.** See [neighborhoods](#neighborhoods).
- **Language steers depth. It doesn't file a query.** See
  [intent focus](#intent-focus).

If you're building UI on top of atlas and you find yourself reaching
for a router, a modal stack, or a tab bar — stop. That's the signal
you've drifted back toward navigation instead of depth.

---

## Installation

```bash
pnpm add @xo/atlas
```

Zero runtime dependencies. Ships ESM with full type declarations.
Works anywhere modern JavaScript runs — browser, server, a test
runner — because atlas never assumes a DOM, a frame loop, or a
particular UI framework. You drive its clock; it does the rest.

---

## The Camera

The camera **is** navigation — there is no other navigation primitive
in atlas. It has a position on the plane and an altitude (how deep it
is), and it moves through both continuously.

```ts
import { Camera, AltitudeModel } from '@xo/atlas'

const altitudes = new AltitudeModel([
  { id: 'ecosystem', order: 0, label: 'Ecosystem' },
  { id: 'community', order: 1, label: 'Communities' },
  { id: 'experience', order: 2, label: 'Experiences' },
  { id: 'capability', order: 3, label: 'Capabilities' },
  { id: 'workflow', order: 4, label: 'Workflow' },
  { id: 'reasoning', order: 5, label: 'Reasoning' },
  { id: 'memory', order: 6, label: 'Memory' },
  { id: 'execution', order: 7, label: 'Execution' },
])

const camera = new Camera({ altitudeModel: altitudes })

// Somewhere in your render loop / frame callback:
function frame(dtSeconds: number) {
  camera.tick(dtSeconds)
  // read camera.position, camera.altitude, camera.focused and draw
}
```

Atlas never drives its own clock. A React binding calls `tick()` from
`requestAnimationFrame`; a test calls it with whatever `dt` it likes.
This is what makes the camera fully deterministic and unit-testable —
see `tests/camera.test.ts` for an example that reproduces an identical
trajectory from an identical tick sequence.

### The movement vocabulary

| Method | What it means |
|---|---|
| `flyTo(position, opts?)` | Move toward a point in the plane. |
| `zoomTo(altitude \| levelId, opts?)` | Move to a depth, by number or by a configured level id. |
| `focus(id, position, opts?)` | Give attention to an entity without necessarily changing depth. |
| `unfocus(opts?)` | Drop attention; optionally rise a level. |
| `enter(id, position)` | Focus and move one configured level deeper — the closest thing to "opening" something. |
| `leave()` | Drop focus and rise one configured level. |
| `orbit(center, opts)` | Circle continuously around a point — ambient motion, for watching rather than travelling. |
| `follow(id, getPosition)` | Softly track a moving target each tick. |
| `remember(label?)` | Deliberately bookmark the current place. |
| `restore(idOrLabel)` | Fly back to a remembered place. |
| `back()` / `forward()` | Move through automatic navigation history. |

Every committing method pushes onto [`NavigationHistory`](#navigation-history)
automatically. None of them ever produces a hard cut — even
`restore()` flies to the remembered place rather than teleporting;
only the internal `jump`-style primitive (used solely to seed a
camera's very first position) skips motion entirely.

### Altitude is configurable, not hardcoded

`AltitudeModel` takes whatever levels the consumer defines. A
marketplace might use eight levels from *Ecosystem* down to
*Execution*. A debugger might use three: *Process*, *Stack Frame*,
*Variable*. Atlas has no opinion — it only needs levels to be ordered
and non-overlapping.

---

## Semantic zoom

Map zoom makes things bigger. Semantic zoom makes things **more
true** — new meaning is revealed at depth, never just a magnified
version of what was already on screen.

```ts
import { SemanticZoomRegistry } from '@xo/atlas'

const zoom = new SemanticZoomRegistry<{ label: string }>()

zoom.register({ id: 'headline', appearsAt: 0, fullyVisibleAt: 0.5, data: { label: 'name & status' } })
zoom.register({ id: 'capabilities', appearsAt: 1, fullyVisibleAt: 2 })
zoom.register({ id: 'memory-graph', appearsAt: 5, fullyVisibleAt: 6 })

zoom.visible(camera.altitude) // → everything currently emerged, with a
                              //   continuous 0–1 visibility to fade by
```

`visibility` interpolates smoothly between `appearsAt` and
`fullyVisibleAt` — the consumer fades opacity, scale, or detail level
by that number. Nothing is ever told to "pop in." `data` is opaque to
atlas; put whatever your UI needs there.

---

## Spatial memory

Deliberate, not automatic. A visitor bookmarking a place, or the
system remembering that they've been somewhere, independent of
whether they explicitly saved it.

```ts
import { SpatialMemory } from '@xo/atlas'

const memory = new SpatialMemory()
const placeId = memory.remember(camera.snapshot(), 'forge, mid-build')
memory.markVisited('forge')

memory.hasVisited('forge')       // true
memory.recall('forge, mid-build') // → { snapshot, label, createdAt }

// Persist across sessions however the consumer likes:
localStorage.setItem('xo:memory', JSON.stringify(memory.export()))
memory.import(JSON.parse(localStorage.getItem('xo:memory')!))
```

This is what lets a return visit feel like the ecosystem kept
existing without the visitor — atlas holds the data; persisting it is
the consumer's job, deliberately, so a marketplace, Studio, and
Runtime can each choose their own storage without atlas caring.

---

## Navigation history

Involuntary, automatic — the trail the camera has actually walked,
independent of anything a visitor chose to remember.

```ts
import { NavigationHistory } from '@xo/atlas'

const history = new NavigationHistory({ limit: 200 })
// A Camera creates and manages its own NavigationHistory by default;
// pass one in only if you need to share history across multiple
// cameras or inspect it independently.
```

`camera.back()` / `camera.forward()` are the only "back button" atlas
has, and they never load a different page — they fly the same camera
to an earlier snapshot of the same world.

---

## Neighborhoods

Pure spatial infrastructure for things organizing themselves — no
opinion about what a cluster, district, or landmark *means*.

```ts
import { NeighborhoodEngine } from '@xo/atlas'

const world = new NeighborhoodEngine()
world.place('signal', { x: 22, y: 28 })
world.place('relay', { x: 49, y: 20 })
world.place('forge', { x: 65, y: 66 })

world.neighborsOf('signal', 3)        // k nearest, closest first
world.within('signal', 40)            // everything inside a radius
world.clusterByProximity(25)          // emergent clusters + centroids
world.markLandmark('relay')
world.nearestLandmark({ x: 40, y: 25 })
world.defineRoute('onboarding-tour', ['signal', 'relay', 'forge'])
world.routeLength('onboarding-tour')
```

`clusterByProximity` is deterministic single-linkage clustering —
identical positions and radius always produce identical clusters,
regardless of insertion order. `defineDistrict` exists alongside it
for groupings a consumer wants to declare by hand rather than derive.

---

## Intent focus

"Language steers depth. It doesn't file a query." Atlas has no
opinion about language — turning a sentence into candidates (search,
embeddings, whatever) is the consumer's job. What atlas provides is
the infrastructure of attention itself.

```ts
import { IntentFocus } from '@xo/atlas'

const intent = new IntentFocus({ decayPerSecond: 0.1, blend: 'weighted-centroid' })

// After the consumer resolves "I need to understand a market before I pitch it"
// into candidate entities with relevance scores:
intent.update([
  { id: 'signal', position: { x: 22, y: 28 }, score: 0.9 },
  { id: 'atlas', position: { x: 31, y: 64 }, score: 0.4 },
])

const target = intent.target() // where to steer the camera
if (target) camera.flyTo(target)
```

Unreinforced attention decays on its own if `decayPerSecond` is set —
the camera's pull toward something fades the way a person's glance
elsewhere fades if nothing keeps their attention.

---

## How each surface is expected to use it

**Marketplace.** One `AltitudeModel` running from *Ecosystem* down to
*Execution*. A `NeighborhoodEngine` positions Experiences by what
they're currently exchanging work with, not by category. Discovery
copy becomes `IntentFocus` candidates; the "install" moment is
`camera.enter()` plus `remember()`.

**Studio.** A different, shallower `AltitudeModel` — perhaps just
*Canvas* → *Component* → *Logic* — reusing the same `Camera` and
`SemanticZoomRegistry` machinery so a builder feels like the same
world as the marketplace, only zoomed to a different purpose.

**Runtime.** `follow()` is built for this: a running workflow's
position can move as it executes, and a camera watching it in
production tooling tracks it live rather than polling and re-centering.

**Compiler / Debugger.** A three- or four-level `AltitudeModel`
(*Process* → *Stack Frame* → *Variable*, say) with `SemanticZoom`
rules revealing more of a value's structure the deeper you go — the
same emergence model as a marketplace revealing an Experience's
memory graph, applied to a completely different domain. This is the
proof that atlas is infrastructure, not a marketplace feature: it has
no idea it's being used for either.

---

## Design principles for this package specifically

- **No UI framework dependency, ever.** Atlas is plain TypeScript.
  Bindings for React, Vue, or anything else are separate packages
  that depend on atlas — atlas never depends on them.
- **No business logic.** Nothing in here knows what an "Experience"
  or a "capability" is. If a change requires atlas to understand a
  domain concept, that logic belongs in the consumer.
- **Stable public surface.** Only what `src/index.ts` exports is
  supported. Everything under `src/internal/` can change at any time
  without a version bump implication for the public API.
- **Deterministic by construction.** Every stateful class accepts an
  injectable clock (`now: () => number`) or an explicit `now`
  argument specifically so behavior can be reproduced exactly in
  tests, without faking timers.

---

## Development

```bash
npm run build   # type-check and emit dist/ (ESM + .d.ts)
npm test        # type-check src + tests, run the full suite via node:test
npm run bench   # run performance benchmarks for the hot paths
```

The test suite uses Node's built-in `node:test` and `node:assert` —
zero test-framework dependency, deterministic by design (fixed tick
sequences, injectable clocks), covering the camera, altitude model,
semantic zoom, spatial memory, navigation history, neighborhoods, and
intent focus independently of one another.
