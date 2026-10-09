# @xo/graph-ui

A reusable, framework-agnostic graph **interaction engine** for the XO Platform.

`graph-ui` is the single visualization and interaction layer shared by XO
Studio, the runtime debugger, the compiler visualizer, the package
explorer, and future Registry UI / web dashboards. It has **no dependency
on the compiler, runtime, studio, registry, marketplace, or any business
logic** — it only knows about graphs: nodes, edges, layout, viewport,
selection, search, filtering, styling, and the full interaction surface
(drag/resize/marquee/lasso/touch/focus, smart selection, spatial indexing,
virtualization, constraints, snapping, grouping, camera, plugins,
diagnostics) an editor like Studio needs to build on top of it. Everything
is pure TypeScript — no React assumptions, no DOM assumptions, no runtime
assumptions.

## Architecture

The package is organized in layers, each independently testable and each
depending only on the layers below it:

```
┌─────────────────────────────────────────────────────────┐
│ GraphCanvas          host-agnostic façade (wires it all) │
├─────────────────────────────────────────────────────────┤
│ GraphController      orchestrates state, single API      │
│   ↳ model undo/redo history built on HistoryStack<T>     │
├──────────────┬──────────────┬──────────────┬─────────────┤
│ Selection    │ Search       │ Filtering    │ Execution   │
├──────────────┴──────────────┴──────────────┴─────────────┤
│ Layout       │ Viewport     │ Interaction  │ Theme       │
├──────────────┴──────────────┴──────────────┴─────────────┤
│ Rendering (GraphRenderer + pluggable GraphRenderAdapter)  │
├─────────────────────────────────────────────────────────┤
│ Core Model (GraphModel, GraphNode, GraphEdge, ...)        │
└─────────────────────────────────────────────────────────┘

Cross-cutting, all built only on the layers above:
┌─────────────┬────────────┬───────────┬─────────┬──────────┐
│ Adapters    │ Inspector  │ Animation │ Export  │ Commands │
│ (domain →   │ contracts  │  engine   │ system  │   API    │
│  GraphModel)│ (data-only)│           │         │          │
└─────────────┴────────────┴───────────┴─────────┴──────────┘
```

Every layer's state (`GraphModel`, `GraphViewport`, `GraphSelection`,
`GraphSearch`, `GraphFilters`, `GraphTheme`, `GraphExecutionState`) is
**immutable** — every mutating method returns a new instance. `GraphController`
is the one place that holds mutable, "current" state and notifies subscribers
when it changes; everything below it is pure data + pure functions.

No React Flow (or any other rendering library) type ever appears in the
public API. If an underlying rendering library is used, it is isolated
behind a `GraphRenderAdapter`.

## Rendering pipeline

`GraphRenderer.buildFrame(model, theme, viewport, viewportSize, selection, execution, options)`
composes everything into one deterministic `RenderFrame` (nodes + edges +
resolved styles + screen-ready points), then hands it to a `GraphRenderAdapter`.

```
GraphModel ─┐
GraphTheme ─┼─▶ GraphRenderer.buildFrame ─▶ RenderFrame ─▶ adapter.render(frame)
Viewport   ─┤
Selection  ─┤
Execution  ─┘
```

- **Deterministic ordering** — nodes/edges render in the model's insertion
  order, not `Map` iteration order, so two renders of the same model always
  produce the same output (see `test/large-graph.test.ts`).
- **Viewport culling / virtualization** — once `nodeCount + edgeCount`
  exceeds `virtualizationThreshold` (default 500), only nodes intersecting
  the visible world rect are included in the frame. An edge still renders if
  either endpoint is visible, so partially on-screen edges are never cut off.
  Below the threshold, culling is skipped so small graphs never pay for it.
- **Incremental updates** — because `GraphModel` is immutable and cheap to
  diff by reference, adapters can decide how to reconcile a new frame
  against the previous one (e.g. React Flow's own reconciliation, or a
  custom Canvas dirty-rect strategy).

### Adapters

`GraphRenderAdapter` is the only interface a rendering backend must
implement (`render(frame)`, optional `dispose()`). Two ship today:

- **`SvgStringAdapter`** — the reference adapter. Renders to a deterministic,
  HTML-escaped SVG string with no DOM dependency, so it runs identically in
  Node (tests, SSR, snapshot export) and the browser.
- **`createReactFlowAdapter(bindings)`** — drives an externally-owned React
  Flow instance via dependency-injected `setNodes`/`setEdges` functions.
  `graph-ui` never imports `reactflow`/`@xyflow/react` itself — the host
  application wires its own `useNodesState`/`useEdgesState` setters in. This
  is how React Flow can be swapped for a Canvas or WebGL adapter later
  without touching anything above the rendering layer.

Additional adapters (Canvas, WebGL) implement the same three-method
interface and drop in without changes elsewhere in the package.

## Layout system

`GraphLayouts` is a registry of pluggable `LayoutEngine`s. Seven ship
built-in: `hierarchical`, `dag`, `tree`, `force-directed`, `circular`,
`grid`, `manual`. Register additional engines with `layouts.register({ kind, compute })`.

```ts
const layouts = new GraphLayouts();
const result = layouts.compute('hierarchical', model, { direction: 'LR' });
const laidOutModel = layouts.apply('hierarchical', model, { direction: 'LR' });
```

- `hierarchical` / `dag` share a BFS-layering algorithm (longest path from
  roots, safe on cycles and disconnected components).
- `tree` does a DFS subtree layout, centering each parent over its children.
- `force-directed` is a deterministic (seeded, no `Math.random`) simplified
  Fruchterman–Reingold simulation with a cooling schedule.
- `circular` / `grid` / `manual` are direct geometric placements.

## Search

`GraphSearch.run(query, model)` matches by label, id, or metadata value,
case-insensitively, and returns every match with `next()` / `previous()` to
cycle through them (wrapping at both ends).

## Filtering

`GraphFilters` is a set of predicates (node type, edge type, label,
metadata, explicit hidden ids, collapsed group ids) applied as a **pure
projection**: `filters.apply(model)` returns a new, smaller `GraphModel` —
the base model is never mutated. An edge is only visible if both its
endpoints are visible, so filtering never leaves a dangling edge on screen.

## Theming

`GraphTheme` resolves the effective style for a node/edge by cascading:

```
default → type-specific → execution-status → hover → selected
```

Ships with `light`, `dark`, and `high-contrast`; `GraphTheme.custom(...)` or
`theme.extend({...})` build fully custom themes, including per-node-type and
per-edge-type style overrides and execution-status colors (`pending` /
`active` / `completed` / `failed`).

## Execution visualization

`GraphExecutionState` is pure styling-hook state — active/completed/failed/pending
node status, the traversed execution path, and which edges are animated. It has
zero knowledge of the XO runtime; a runtime debugger UI translates its own
execution events into calls like `execution.markActive(nodeId)`.

## Minimap

`GraphMinimap.geometry(...)` computes the small-scale mapping of world
bounds and the current viewport rectangle into minimap pixel space (zoom-aware
— the rectangle shrinks as the main viewport zooms in). `GraphMinimap.navigateFromClick(...)`
does the inverse mapping for click-to-navigate.

## Performance characteristics

- `GraphModel` batches bulk writes: `upsertNodes`/`upsertEdges` copy the
  underlying maps **once** regardless of how many nodes/edges are added,
  not once per item — bulk-loading nodes is O(n), not O(n²).
- Rendering culls to the visible viewport once a graph crosses the
  virtualization threshold, so adapters only ever receive what's on screen.
- `grid`/`circular`/`manual`/`hierarchical`/`dag` are all O(n + e). `tree`
  is also O(n + e) and, as of this version, **iterative** rather than
  recursive: it does a BFS pass down (assigning depth + a single BFS-tree
  parent) and one reverse pass back up (centering each parent over its
  children), instead of a recursive DFS. A recursive implementation would
  blow the call stack on a very deep tree or a long linear chain at scale;
  the iterative version doesn't, and `test/stress-100k.test.ts` specifically
  checks a 100,000-node linear chain for this.
- `force-directed` is O(n² · iterations) per run (all-pairs repulsion) and
  is intended for small-to-medium graphs — prefer `hierarchical`/`grid` for
  very large graphs.
- Verified at **100,000 nodes / 500,000 edges** in `test/stress-100k.test.ts`:
  graph construction, grid/hierarchical/tree layout, filtering, viewport
  culling, search, and minimap geometry all complete well within a few
  seconds each on ordinary CI hardware, with deterministic ordering
  preserved throughout. See `test/large-graph.test.ts` for the smaller
  10,000-node correctness/perf checks that predate the 100k target.

## Adapter architecture

`GraphAdapter<TSource>` is the contract every domain adapter implements:
`{ kind, toGraphModel(source) }`. Adapters are **pure conversion layers** —
they only build a `GraphModel` from a plain-data source shape they document
themselves; they never import compiler, runtime, studio, registry, or
marketplace types, and they never run layout (every node lands at
`{ x: 0, y: 0 }` — call `controller.applyLayout(...)` afterward).

```
domain data (source shape the adapter documents)
        │
        ▼
GraphAdapter.toGraphModel(source)
        │
        ▼
   GraphModel  ──▶  controller.applyLayout(...)  ──▶  ready to render
```

Seven ship today, one per XO subsystem graph shape:

| Adapter | Converts | Node types produced |
|---|---|---|
| `KnowledgeGraphAdapter` | entities + relations | `entity`, `concept` |
| `CapabilityGraphAdapter` | capabilities + actions | `capability`, `action` |
| `IntentGraphAdapter` | intents + slots | `intent`, `slot` |
| `WorkflowGraphAdapter` | steps + transitions | `step`, `decision` |
| `PermissionGraphAdapter` | roles + resources + grants | `role`, `resource` |
| `ExecutionGraphAdapter` | execution nodes + edges (+ optional status snapshot) | caller-defined (`task` by default) |
| `DependencyGraphAdapter` | packages + dependencies | `package` |

`ExecutionGraphAdapter` also exports `executionStateFromSource(source)`,
which turns an optional `statuses` map on the source into a
`GraphExecutionState` — still pure data, still zero runtime imports; a
runtime debugger maps its own execution events into that shape.

Because each adapter's node `type` values line up with the corresponding
preset's `nodeTypeStyles` keys (see `src/presets`), a typical integration
is: `adapter.toGraphModel(source)` → `controller.applyLayout(preset.defaultLayout)`
→ `controller.setTheme(preset.theme)`.

## Inspector contracts

Pure, immutable data shapes for a host inspector panel — **no UI, no
rendering, no side effects**: `GraphInspectorData`, `GraphPropertyGroup`,
`GraphProperty`, `GraphMetadataEntry`, `GraphBadge`, `GraphTooltip`,
`GraphOverlay`, `GraphContextMenu`. `GraphInspector.fromNode(node)` /
`.fromEdge(edge)` are the only functions in this module, and both just
read what's already on the node/edge (id, type, label, metadata) into
these shapes — a host inspector UI (in Studio, the runtime debugger, ...)
is responsible for actually rendering them.

Note: `GraphMetadataEntry` (a display-oriented key/label/value row) is
distinct from the core model's `GraphMetadata` (an arbitrary JSON bag) —
the inspector module never overloads that name.

## Animation system

Every animation in `graph-ui` is a **pure function of time**: there is no
internal timer and no `requestAnimationFrame` call anywhere in the package.
`GraphAnimation<T>.progressAt(nowMs)` / `.valueAt(nowMs, lerp)` compute the
animation's state given whatever "now" the host's own render loop passes
in — which makes every animation reproducible and directly unit-testable
(see `test/animation.test.ts`), and keeps the engine rendering-library
agnostic.

`GraphAnimationEngine` is an immutable, keyed registry of in-flight
`GraphAnimation` instances (`start`/`stop`/`get`/`prune`). On top of those
two primitives, named helpers cover every category the platform needs:

| Category | Start | Read |
|---|---|---|
| Node move | `animateNodePosition` | `nodePositionAt` |
| Edge flow | `animateEdgeFlow` (loops) | `edgeFlowPhaseAt` |
| Highlight | `animateHighlight` (loops, pulses 0→1→0) | `highlightIntensityAt` |
| Selection | `animateSelectionEnter` (fades in, holds) | `selectionIntensityAt` |
| Execution active | `animateExecutionActive` (loops, pulses) | `executionIntensityAt` |
| Viewport transition | `animateViewportTransition` | `viewportStateAt`, `isViewportTransitionComplete` |

**Animated execution path** is handled separately by
`computeExecutionPathReveal(path, stepDurationMs, startedAtMs, nowMs)`,
which deterministically computes how much of a `GraphExecutionState.path`
should currently be "revealed" — this is what animates a runtime
debugger's execution trail appearing node by node.

## Export system

Every exporter is a pure function taking a `RenderFrame` (from
`GraphRenderer.buildFrame`) or a `GraphModel`/`GraphControllerState` and
returning data — none of them touch the DOM, the clipboard, or the
filesystem directly, so the host application stays in control of actually
writing the result somewhere:

- **SVG** — `exportToSvg(frame, options?)`: deterministic, self-contained
  SVG document string (explicit `viewBox`/width/height sized to content).
- **PNG** — `exportToPng(frame, rasterize, options?)`: builds the same SVG,
  then hands it to a host-supplied `rasterize(svgMarkup, size)` function.
  Real PNG rasterization needs a real image backend (a browser `<canvas>`,
  `sharp`, `resvg`, ...); `graph-ui` stays zero-dependency by using the same
  dependency-injection pattern as `createReactFlowAdapter` instead of
  bundling one.
- **JSON** — `exportModelToJson`/`importModelFromJson` (and the
  object-level `modelToJsonObject`/`modelFromJsonObject`) round-trip a
  `GraphModel` exactly.
- **Clipboard** — `buildJsonClipboardPayload`/`buildSvgClipboardPayload`
  return a `{ mimeType, data }` payload rather than calling
  `navigator.clipboard` directly (another browser API graph-ui has no
  business depending on) — the host writes it with whatever clipboard API
  fits its environment.
- **Snapshot** — `captureSnapshot(state, nowMs)` captures model + viewport +
  selection + theme into one JSON-serializable object;
  `exportSnapshotToJson`/`importSnapshotFromJson` serialize it;
  `applySnapshot(controller, snapshot)` restores it onto a live controller
  through the controller's public API only.
- **Print-friendly** — `exportToPrintSvg(frame, options?)` is `exportToSvg`
  with a forced white background, regardless of the active theme.

## History

`HistoryStack<T>` is the one generic, immutable undo/redo primitive
(`push`/`undo`/`redo`/`canUndo`/`canRedo`/`reset`) everything else is built
from — `past`/`present`/`future`, exactly like a browser history stack.

- **Model history** is wired directly into `GraphController`:
  `setModel`/`updateModel`/`applyLayout` all commit to it, and
  `controller.undo()`/`controller.redo()`/`controller.canUndo`/`controller.canRedo`
  are the public API (see `test/controller.test.ts`).
- **Viewport / selection / navigation history** are provided as standalone,
  typed `HistoryStack` aliases (`createViewportHistory`,
  `createSelectionHistory`, `createNavigationHistory` +
  `ViewportHistory`/`SelectionHistory`/`NavigationHistory`/`NavigationEntry`)
  that a host application (e.g. Studio) composes on top of a controller as
  needed, rather than being force-wired into `GraphController` itself —
  keeping the controller's own state shape unchanged.

## Command API

`GraphCommandRegistry` maps generic command names to handlers that operate
on a `GraphCommandContext` (`{ controller, viewportSize? }`) — every
built-in is implemented purely through `GraphController`'s already-public
methods, never by reaching past it:

`zoomIn`, `zoomOut`, `fit`, `center`, `search`, `highlight`, `expand`,
`collapse`, `selectAll`, `clearSelection`.

```ts
const commands = new GraphCommandRegistry();
commands.execute('center', { controller, viewportSize }, { nodeId: 'n1' });
commands.register('myCustomCommand', (ctx, args) => { /* ... */ });
```

Registering a new command (`registry.register(name, handler)`) works
exactly like `GraphLayouts.register` — same extensibility pattern as the
rest of the package.

## Advanced Interaction Engine

Everything in this section is new, purely additive, renderer-agnostic
(no React, no DOM, no browser APIs), and immutable/deterministic in the
same style as the rest of the package. It's what turns `graph-ui` from a
graph library into an interaction engine — the layer XO Studio actually
builds its editing experience on.

### Interaction primitives

State machines and trackers, each returning a new instance per transition
— no hidden mutable state, no timers:

- **`DragStateMachine`** / **`ResizeStateMachine`** — `begin`/`move`/`end`/`cancel`,
  with `resultingSize` computed per resize-handle (n/s/e/w/ne/nw/se/sw).
- **`MarqueeSelection`** (rectangular box-select) / **`LassoSelection`**
  (free-form polygon, even-odd point-in-polygon test) — both expose
  `matchingNodeIds(model)`/`toSelection(model)`.
- **`TouchGestures`** — per-touch-id point tracking; `TouchGestures.gestureBetween(before, after)`
  is a pure function recognizing a one-finger pan or two-finger pinch
  (with scale) between two snapshots.
- **`HoverManager`** — single-target hover (like a real pointer), with
  `hoverDurationMs`.
- **`ClickArbiter`** — immutable single/double-click and long-press
  arbitration from explicit `pointerDown`/`pointerUp` timestamps (the host
  supplies the clock; there's no internal timer).
- **`FocusManager`** — keyboard focus + accessibility tab order
  (`FocusManager.tabOrder` = the model's deterministic node order),
  `focusNext`/`focusDirectional` (reuses `GraphInteraction`'s spatial
  neighbor search for arrow-key navigation).

### Smart Selection

`SmartSelection` — pure graph-aware selection algorithms over `GraphModel`
connectivity: `connectedComponent`, `upstream`/`downstream`/`dependencyChain`,
`executionPath` (reads a `GraphExecutionState.path`), `hierarchy`/`group`
(via `NodeGroup`, including nested groups), `range` (shift-click style,
using the model's deterministic order), `invert`, `expand`, `contract`.

`SavedSelections` is a separate, immutable name→`GraphSelection` registry
("save this selection as a preset, recall it later") — distinct from the
chronological `SelectionHistory` type already in `history/`.

### Spatial Index

Three pieces, all built once per `GraphModel` snapshot and queried
read-only afterward (rebuild when the model changes, same trade-off as
everywhere else immutable in this package):

- **`Quadtree`** — capacity/depth-bounded region quadtree. Guards against
  the classic degenerate case where entries are large relative to the
  region (e.g. many overlapping node rects): subdivision only happens if
  it would actually reduce per-child load, otherwise the node stays a
  leaf with more than `capacity` entries rather than recursing forever —
  see `test/spatial-stress.test.ts` for the case that used to blow up
  without this guard.
- **`RTree`** — static, bulk-loaded via **STR** (Sort-Tile-Recursive) in
  O(n log n); `nearest()` uses branch-and-bound pruning against each
  node's bounding rect rather than scanning every leaf.
- **`SpatialIndex`** — the facade both back: `queryViewport`/`queryRegion`,
  `collidingNodes`, `nearestNode`/`nearestEdge`, `queryEdgesInRect`.

Verified at 100k nodes (`test/spatial-stress.test.ts`): both backends
build in well under a second and query in milliseconds.

### Virtualization

`VirtualizationEngine` — renderer-independent: `lodForZoom` (full /
simplified / dot), `importanceScore`, deterministic grid-bucket `cluster`
(fires automatically at `dot` LOD once visible count exceeds
`clusterThreshold`), `predictiveViewport` (expands a viewport rect along a
velocity vector for prefetch), and the static `VirtualizationEngine.diff`
(entered/exited node ids between two visible sets — the basis for
incremental renderer updates). `computeVisible` ties it together: cull via
a `SpatialIndex`, pick an LOD, cluster if warranted.

### Constraint Engine

`ConstraintEngine` — an immutable per-node constraint registry
(`lockedAxis`/`lockedPosition`, `snapGroupId` + `minSpacing`, per-node
`gridSize`) plus `resolve(model, proposedPositions)`, which reconciles a
batch of proposed moves against every constraint in one pass. `align`/
`distribute` are one-shot pure functions (not persistent constraints) for
aligning or evenly spacing a set of nodes along an axis.

### Snap Engine

`SnapEngine.resolve(model, excludeId, point, size)` — checks edge, center,
and grid snapping against every sibling node within `magneticRadius`,
returns the resolved point plus the `SnapGuide[]` that fired (for
rendering alignment lines), with support for host-supplied custom guides.
"Magnetic" is just the snap radius — nothing snaps outside it.

### Grouping System

`GraphGrouping` — pure helpers on top of `NodeGroup`, including **nested
groups** via a new, additive, optional `parentGroupId` field (omitting it
keeps a group flat exactly as before this field existed):
`nestedChildren`, `allMemberNodeIds` (recursive), `bounds`,
`toggleCollapse`, `fromSelection` (persist the current selection as a
group, tagged with a `GroupKind` — semantic/visual/bounding/selection —
via `group.metadata.kind`, not a new `NodeGroup` field), `temporary`
(ephemeral, never written to the model), `translate` (move every member,
including nested, by a delta).

### Layout Transitions

`computeLayoutTransition(fromModel, toModel, durationMs, startedAtMs)` —
seeds one node-position animation (via the existing `animateNodePosition`)
per node whose position actually changed between two model snapshots, so
switching layouts glides rather than jumps ("preserve the mental map").
`renderTransitionFrame`/`layoutTransitionPositionAt` read back the
interpolated positions each frame; `isLayoutTransitionComplete` tells the
host when to commit `toModel` to the controller. Built entirely on the
animation engine already described above — no new animation mechanism.

### Camera Engine

`GraphCamera` wraps `GraphViewport` (all pan/zoom/fit math still lives
there) and adds: named **bookmarks**, undo/redo **history** (built on
`HistoryStack`), and **animated travel** (`travelTo` — built on the
animation engine's viewport-transition helpers). `GraphCameraGroup` holds
multiple named cameras and supports **linking**: panning or zooming a
linked camera propagates the same delta to every other linked camera
(e.g. a main view + minimap staying in lockstep).

### Plugin System

A `GraphPlugin` declares what it contributes — `layouts`, `commands`,
`animations`, `selectionBehaviors`, `exporters`, `validators`,
`decorators` — and `installPlugin(plugin, { layouts, commands })` wires
each piece into the corresponding *existing* registry
(`GraphLayouts.register`, `GraphCommandRegistry.register`) via
composition; it never reaches into or modifies core class internals.
`GraphPluginRegistry` additionally tracks installed plugins and namespaces
anything without a dedicated registry (animations, selection behaviors,
exporters, validators, decorators) as `${pluginName}:${itemName}`, plus
`validateAll(model)` to run every registered validator at once.

### Diagnostics

`GraphDiagnostics` — deterministic profiling: `measure`/`timeLayout`/`timeSearch`/`timeSelection`
(wall-clock timing via `Date.now()`, not a browser-specific API),
`estimateRenderCost`/`estimateMemory` (rule-based heuristics, not measured
samples — graph-ui has no access to a real heap snapshot and shouldn't
assume one), `hotspots` (filters + sorts named timing samples above a
threshold), and `recommendations` (rule-based advice, e.g. "force-directed
above a few thousand nodes", "enable virtualization above ~500 nodes").

### Developer Tools

Pure, JSON-serializable snapshot builders — **no UI, no rendering** — one
per concern: `inspectGraph`, `inspectInteraction`, `inspectSelection`,
`inspectLayout`, `inspectCamera`, `inspectPerformance`, `inspectAnimation`,
`inspectHistory`. Plus `Timeline<T>` — an append-only, immutable, capped
log (`EventTimeline`/`CommandTimeline` are typed specializations of it)
for building an event/command history view.

## Public API

```ts
import {
  GraphCanvas,
  GraphRenderer,
  GraphController,
  GraphModel,
  GraphLayouts,
  GraphTheme,
  GraphSearch,
  GraphFilters,
} from '@xo/graph-ui';
```

These eight are the primary API surface. Everything else Studio needs is
also exported from the same top-level barrel and organized by concern —
nothing below is reachable except through `@xo/graph-ui` itself:

- **Supporting core classes**: `GraphViewport`, `GraphSelection`,
  `GraphExecutionState`, `GraphMinimap`, `GraphInteraction`.
- **Rendering**: `GraphRenderAdapter`/`RenderFrame` types, `SvgStringAdapter`,
  `createReactFlowAdapter`.
- **Presets**: `GraphPresets` + all ten named presets.
- **Adapters**: all seven domain adapters + their source-shape types +
  `executionStateFromSource`.
- **Inspector**: `GraphInspector` + all inspector contract types.
- **Animation**: `GraphAnimation`, `GraphAnimationEngine`, every named
  animation helper, `Easings`/`Easing`, the `lerp*` helpers.
- **Export**: every exporter function + `GraphSnapshot`/`ClipboardPayload`/
  `ExportFormat` types.
- **History**: `HistoryStack` + the three typed history factories.
- **Commands**: `GraphCommandRegistry` + `BUILTIN_COMMAND_NAMES`.
- **Interaction primitives**: `DragStateMachine`, `ResizeStateMachine`,
  `MarqueeSelection`, `LassoSelection`, `TouchGestures`, `HoverManager`,
  `ClickArbiter`, `FocusManager`.
- **Smart selection**: `SmartSelection`, `SavedSelections`.
- **Spatial index**: `Quadtree`, `RTree`, `SpatialIndex`.
- **Virtualization**: `VirtualizationEngine`.
- **Constraints & snapping**: `ConstraintEngine`, `SnapEngine`.
- **Grouping**: `GraphGrouping`.
- **Layout transitions**: `computeLayoutTransition` + its helpers.
- **Camera**: `GraphCamera`, `GraphCameraGroup`.
- **Plugins**: `GraphPluginRegistry`, `installPlugin`.
- **Diagnostics & devtools**: `GraphDiagnostics`, every `inspect*`
  function, `Timeline`/`EventTimeline`/`CommandTimeline`.
- **Core data types**: every type in `src/model/types.ts`.

Internal layout algorithms, controller internals, and per-file helper
functions are not exported; downstream packages depend only on this
contract.

## Future integration examples

These sketch how each XO subsystem is expected to integrate — none of this
runs today (`graph-ui` has zero imports from any of these packages), but
the shapes below are what a real integration would look like against the
current public API:

```ts
// XO Studio: load a workflow, lay it out, wire commands + undo, export a snapshot on save.
import {
  WorkflowGraphAdapter, GraphController, GraphCommandRegistry,
  WorkflowGraphPreset, captureSnapshot, exportSnapshotToJson,
} from '@xo/graph-ui';

const model = WorkflowGraphAdapter.toGraphModel(studioWorkflowToSource(workflow));
const controller = new GraphController({ model, theme: WorkflowGraphPreset.theme });
controller.applyLayout(WorkflowGraphPreset.defaultLayout, WorkflowGraphPreset.layoutOptions);

const commands = new GraphCommandRegistry();
onKeyboardShortcut('mod+z', () => controller.undo());
onKeyboardShortcut('mod+shift+z', () => controller.redo());

onSave(() => saveToDisk(exportSnapshotToJson(captureSnapshot(controller.getState(), Date.now()))));
```

```ts
// Runtime debugger: stream execution events into GraphExecutionState + the animation engine.
import { ExecutionGraphAdapter, GraphController, GraphAnimationEngine, animateExecutionActive } from '@xo/graph-ui';

const controller = new GraphController({ model: ExecutionGraphAdapter.toGraphModel(runtimeSnapshotToSource(snapshot)) });
let animations = GraphAnimationEngine.empty();

onRuntimeEvent((event) => {
  controller.updateExecution((exec) => exec.markActive(event.nodeId));
  animations = animateExecutionActive(animations, event.nodeId, 1200, performance.now());
});
```

```ts
// Compiler visualizer: inspect a node on click, using only data-shaped inspector contracts.
import { DependencyGraphAdapter, GraphInspector } from '@xo/graph-ui';

const model = DependencyGraphAdapter.toGraphModel(compilerGraphToSource(compilationUnit));
onNodeClick((nodeId) => renderInspectorPanel(GraphInspector.fromNode(model.getNode(nodeId)!)));
```

## Examples

See `examples/`:

- `knowledge-graph.ts` — entities/concepts with the `force-directed` preset layout.
- `workflow-graph.ts` — left-to-right steps with a decision branch.
- `execution-graph.ts` — a runtime-debugger-style flow driven by `GraphExecutionState`.
- `capability-graph.ts` — a capability composed of its constituent actions.

Run any of them with `node --import tsx examples/<name>.ts`.

## Testing

```
npm run test
```

269 tests covering: the model, viewport, selection, search, filtering, all
seven layouts (including the iterative tree layout's stack-safety at
100,000-node chain depth), theming, execution state, the minimap, the SVG
adapter, the controller (including undo/redo), interaction, the seven
domain adapters, the inspector contracts, the full animation engine, the
full export system, history (`HistoryStack` + all three typed aliases),
the command registry, end-to-end integration through the public API only,
10,000-node correctness/perf checks, a 100,000-node / 500,000-edge stress
test covering construction, layout, filtering, rendering culling, search,
and minimap geometry — plus, from the Advanced Interaction Engine phase:
every interaction primitive, smart selection algorithm, both spatial-index
backends (including a dedicated regression test for the degenerate-overlap
quadtree case and a 100k-node spatial stress test), virtualization,
constraints, snapping, grouping (including nested groups), layout
transitions, the camera engine (including linked multi-camera sync), the
plugin system, diagnostics, and every devtools inspector.
