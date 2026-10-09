/**
 * Example: rendering a Workflow Graph (left-to-right steps + a decision).
 *
 * Run with: node --import tsx examples/workflow-graph.ts
 */
import { GraphModel, GraphController, GraphRenderer, SvgStringAdapter, WorkflowGraphPreset } from '../src/index.js';

const model = GraphModel.empty()
  .upsertNode({ id: 'start', type: 'step', label: 'Receive Request', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'validate', type: 'step', label: 'Validate Payload', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'route', type: 'decision', label: 'Route by Type', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'fast-path', type: 'step', label: 'Fast Path', position: { x: 0, y: 0 } })
  .upsertNode({ id: 'slow-path', type: 'step', label: 'Slow Path', position: { x: 0, y: 0 } })
  .upsertEdge({ id: 'e1', type: 'next', source: 'start', target: 'validate' })
  .upsertEdge({ id: 'e2', type: 'next', source: 'validate', target: 'route' })
  .upsertEdge({ id: 'e3', type: 'branch', source: 'route', target: 'fast-path', label: 'type=fast' })
  .upsertEdge({ id: 'e4', type: 'branch', source: 'route', target: 'slow-path', label: 'type=slow' });

const controller = new GraphController({ model, theme: WorkflowGraphPreset.theme });
controller.applyLayout(WorkflowGraphPreset.defaultLayout, WorkflowGraphPreset.layoutOptions);

const adapter = new SvgStringAdapter();
const renderer = new GraphRenderer(adapter);
renderer.render(controller.visibleModel, controller.getState().theme, controller.getState().viewport, { width: 900, height: 400 });

console.log(adapter.toString());
