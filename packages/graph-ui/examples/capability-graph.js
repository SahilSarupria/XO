/**
 * Example: a Capability Graph (capabilities composed of actions), rendered
 * top-to-bottom with the built-in preset styling.
 *
 * Run with: node --import tsx examples/capability-graph.ts
 */
import { GraphModel, GraphController, GraphRenderer, SvgStringAdapter, CapabilityGraphPreset } from '../src/index.js';
const model = GraphModel.empty()
    .upsertNode({ id: 'cap:refund-order', type: 'capability', label: 'Refund Order', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'act:lookup-order', type: 'action', label: 'Lookup Order', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'act:check-policy', type: 'action', label: 'Check Refund Policy', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'act:issue-refund', type: 'action', label: 'Issue Refund', position: { x: 0, y: 0 } })
    .upsertEdge({ id: 'e1', type: 'composed_of', source: 'cap:refund-order', target: 'act:lookup-order' })
    .upsertEdge({ id: 'e2', type: 'composed_of', source: 'cap:refund-order', target: 'act:check-policy' })
    .upsertEdge({ id: 'e3', type: 'composed_of', source: 'cap:refund-order', target: 'act:issue-refund' });
const controller = new GraphController({ model, theme: CapabilityGraphPreset.theme });
controller.applyLayout(CapabilityGraphPreset.defaultLayout, CapabilityGraphPreset.layoutOptions);
const adapter = new SvgStringAdapter();
const renderer = new GraphRenderer(adapter);
renderer.render(controller.visibleModel, controller.getState().theme, controller.getState().viewport, { width: 800, height: 500 });
console.log(adapter.toString());
//# sourceMappingURL=capability-graph.js.map