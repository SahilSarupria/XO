/** Installs a plugin's layouts/commands into the given registries (whichever are supplied), and returns everything the plugin contributed that has no existing registry to live in (animations, selection behaviors, exporters, validators, decorators) so the host can hold onto it. */
export function installPlugin(plugin, targets = {}) {
    if (plugin.layouts && targets.layouts) {
        for (const layout of plugin.layouts)
            targets.layouts.register(layout);
    }
    if (plugin.commands && targets.commands) {
        for (const [name, handler] of Object.entries(plugin.commands))
            targets.commands.register(name, handler);
    }
}
/**
 * Immutable registry of installed plugins plus everything they
 * contributed that doesn't have a dedicated existing registry
 * (animations/selectionBehaviors/exporters/validators/decorators) —
 * looked up by `${pluginName}:${itemName}`.
 */
export class GraphPluginRegistry {
    plugins;
    animations;
    selectionBehaviors;
    exporters;
    validators;
    decorators;
    constructor(plugins, animations, selectionBehaviors, exporters, validators, decorators) {
        this.plugins = plugins;
        this.animations = animations;
        this.selectionBehaviors = selectionBehaviors;
        this.exporters = exporters;
        this.validators = validators;
        this.decorators = decorators;
    }
    static empty() {
        return new GraphPluginRegistry(new Map(), new Map(), new Map(), new Map(), new Map(), new Map());
    }
    register(plugin, targets = {}) {
        installPlugin(plugin, targets);
        const plugins = new Map(this.plugins).set(plugin.name, plugin);
        const animations = new Map(this.animations);
        const selectionBehaviors = new Map(this.selectionBehaviors);
        const exporters = new Map(this.exporters);
        const validators = new Map(this.validators);
        const decorators = new Map(this.decorators);
        for (const [name, fn] of Object.entries(plugin.animations ?? {}))
            animations.set(`${plugin.name}:${name}`, fn);
        for (const [name, fn] of Object.entries(plugin.selectionBehaviors ?? {}))
            selectionBehaviors.set(`${plugin.name}:${name}`, fn);
        for (const [name, fn] of Object.entries(plugin.exporters ?? {}))
            exporters.set(`${plugin.name}:${name}`, fn);
        for (const [name, fn] of Object.entries(plugin.validators ?? {}))
            validators.set(`${plugin.name}:${name}`, fn);
        for (const [name, fn] of Object.entries(plugin.decorators ?? {}))
            decorators.set(`${plugin.name}:${name}`, fn);
        return new GraphPluginRegistry(plugins, animations, selectionBehaviors, exporters, validators, decorators);
    }
    has(pluginName) {
        return this.plugins.has(pluginName);
    }
    get pluginNames() {
        return [...this.plugins.keys()];
    }
    getAnimation(key) {
        return this.animations.get(key);
    }
    getSelectionBehavior(key) {
        return this.selectionBehaviors.get(key);
    }
    getExporter(key) {
        return this.exporters.get(key);
    }
    getValidator(key) {
        return this.validators.get(key);
    }
    getDecorator(key) {
        return this.decorators.get(key);
    }
    /** Runs every registered validator against a model and concatenates their issues. */
    validateAll(model) {
        const issues = [];
        for (const validator of this.validators.values())
            issues.push(...validator(model));
        return issues;
    }
}
//# sourceMappingURL=GraphPluginRegistry.js.map