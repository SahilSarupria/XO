/**
 * Example: an Execution Graph driven by GraphExecutionState — this is the
 * shape a runtime debugger would use, animating nodes/edges as steps run.
 * graph-ui itself never imports anything from the runtime; the host
 * application feeds status transitions in as plain function calls.
 *
 * Run with: node --import tsx examples/execution-graph.ts
 */
import {
  GraphModel,
  GraphController,
  GraphRenderer,
  SvgStringAdapter,
  ExecutionGraphPreset,
} from '../src/index.js';

const model = GraphModel.empty()
  .upsertNode({ id: 'fetch', type: 'task', label: 'Fetch Data', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'transform', type: 'task', label: 'Transform', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'validate', type: 'task', label: 'Validate', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'publish', type: 'task', label: 'Publish', position: { x: 0, y: 0 } })
  .upsertEdge({ id: 'e1', type: 'next', source: 'fetch', target: 'transform' })
  .upsertEdge({ id: 'e2', type: 'next', source: 'transform', target: 'validate' })
  .upsertEdge({ id: 'e3', type: 'next', source: 'validate', target: 'publish' });

const controller = new GraphController({ model, theme: ExecutionGraphPreset.theme });
controller.applyLayout(ExecutionGraphPreset.defaultLayout, ExecutionGraphPreset.layoutOptions);

// Simulate a runtime driving the execution visualization step by step.
controller.updateExecution((exec) => exec.markCompleted('fetch').markActive('transform').animateEdge('e1'));

const adapter = new SvgStringAdapter();
const renderer = new GraphRenderer(adapter);
renderer.render(
  controller.visibleModel,
  controller.getState().theme,
  controller.getState().viewport,
  { width: 900, height: 300 },
  controller.getState().selection,
  controller.getState().execution,
);

console.log(adapter.toString());
