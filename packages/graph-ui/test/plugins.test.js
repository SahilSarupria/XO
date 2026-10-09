import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
import { GraphCommandRegistry } from '../src/commands/GraphCommandRegistry.js';
import { GraphController } from '../src/controller/GraphController.js';
import { GraphPluginRegistry, installPlugin } from '../src/plugins/GraphPluginRegistry.js';
function samplePlugin() {
    return {
        name: 'my-plugin',
        layouts: [
            {
                kind: 'diagonal',
                compute: (model) => ({ kind: 'diagonal', positions: model.nodes.map((n, i) => ({ id: n.id, position: { x: i * 10, y: i * 10 } })) }),
            },
        ],
        commands: {
            ping: (ctx) => ctx.controller.selectNode('pinged'),
        },
        animations: { pulse: (engine) => engine },
        selectionBehaviors: { keepAll: (_model, selection) => selection },
        exporters: { csv: () => 'a,b,c' },
        validators: {
            noOrphans: (model) => model.edges.filter((e) => !model.getNode(e.source)).map((e) => ({ severity: 'error', message: 'missing source', edgeId: e.id })),
        },
        decorators: { noop: () => { } },
    };
}
test('installPlugin registers layouts and commands into the given targets', () => {
    const plugin = samplePlugin();
    const layouts = new GraphLayouts();
    const commands = new GraphCommandRegistry();
    installPlugin(plugin, { layouts, commands });
    assert.ok(layouts.has('diagonal'));
    assert.ok(commands.has('ping'));
});
test('installPlugin with no targets is a safe no-op', () => {
    assert.doesNotThrow(() => installPlugin(samplePlugin()));
});
test('GraphPluginRegistry.register tracks the plugin and wires provided targets', () => {
    const layouts = new GraphLayouts();
    const commands = new GraphCommandRegistry();
    const registry = GraphPluginRegistry.empty().register(samplePlugin(), { layouts, commands });
    assert.ok(registry.has('my-plugin'));
    assert.deepEqual(registry.pluginNames, ['my-plugin']);
    assert.ok(layouts.has('diagonal'));
    const controller = new GraphController({ model: GraphModel.empty().upsertNode({ id: 'pinged', type: 't', label: 'P', position: { x: 0, y: 0 } }) });
    commands.execute('ping', { controller });
    assert.ok(controller.getState().selection.hasNode('pinged'));
});
test('GraphPluginRegistry namespaces contributed animations/selectionBehaviors/exporters/validators/decorators by plugin name', () => {
    const registry = GraphPluginRegistry.empty().register(samplePlugin());
    assert.equal(typeof registry.getAnimation('my-plugin:pulse'), 'function');
    assert.equal(typeof registry.getSelectionBehavior('my-plugin:keepAll'), 'function');
    assert.equal(registry.getExporter('my-plugin:csv')(GraphModel.empty()), 'a,b,c');
    assert.equal(typeof registry.getValidator('my-plugin:noOrphans'), 'function');
    assert.equal(typeof registry.getDecorator('my-plugin:noop'), 'function');
    assert.equal(registry.getAnimation('nonexistent:pulse'), undefined);
});
test('GraphPluginRegistry.validateAll runs every registered validator and concatenates issues', () => {
    const model = GraphModel.empty().upsertEdge({ id: 'e1', type: 'l', source: 'ghost', target: 'ghost2' });
    const registry = GraphPluginRegistry.empty().register(samplePlugin());
    const issues = registry.validateAll(model);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].edgeId, 'e1');
});
test('registering a second plugin does not remove the first', () => {
    const registry = GraphPluginRegistry.empty().register(samplePlugin()).register({ name: 'other-plugin' });
    assert.ok(registry.has('my-plugin'));
    assert.ok(registry.has('other-plugin'));
    assert.equal(registry.pluginNames.length, 2);
});
//# sourceMappingURL=plugins.test.js.map