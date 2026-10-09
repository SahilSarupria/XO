/**
 * Example: rendering a Knowledge Graph with the built-in preset.
 *
 * Run with: node --import tsx examples/knowledge-graph.ts
 */
import { GraphModel, GraphController, GraphRenderer, SvgStringAdapter, KnowledgeGraphPreset } from '../src/index.js';
const model = GraphModel.empty()
    .upsertNode({ id: 'concept:distributed-systems', type: 'concept', label: 'Distributed Systems', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'entity:raft', type: 'entity', label: 'Raft', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'entity:paxos', type: 'entity', label: 'Paxos', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'concept:consensus', type: 'concept', label: 'Consensus', position: { x: 0, y: 0 } })
    .upsertEdge({ id: 'e1', type: 'relates_to', source: 'concept:distributed-systems', target: 'concept:consensus' })
    .upsertEdge({ id: 'e2', type: 'implements', source: 'entity:raft', target: 'concept:consensus' })
    .upsertEdge({ id: 'e3', type: 'implements', source: 'entity:paxos', target: 'concept:consensus' });
const controller = new GraphController({ model, theme: KnowledgeGraphPreset.theme });
controller.applyLayout(KnowledgeGraphPreset.defaultLayout, KnowledgeGraphPreset.layoutOptions);
const adapter = new SvgStringAdapter();
const renderer = new GraphRenderer(adapter);
renderer.render(controller.visibleModel, controller.getState().theme, controller.getState().viewport, { width: 800, height: 600 });
console.log(adapter.toString());
//# sourceMappingURL=knowledge-graph.js.map