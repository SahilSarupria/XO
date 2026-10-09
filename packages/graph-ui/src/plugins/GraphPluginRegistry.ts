import type { GraphLayouts } from '../layout/GraphLayouts.js';
import type { LayoutEngine } from '../layout/types.js';
import type { GraphCommandRegistry } from '../commands/GraphCommandRegistry.js';
import type { GraphCommandContext, GraphCommandHandler } from '../commands/types.js';
import type { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import type { GraphAnimation } from '../animation/GraphAnimation.js';
import type { GraphModel } from '../model/GraphModel.js';
import type { GraphSelection } from '../selection/GraphSelection.js';

export type AnimationFactory = (engine: GraphAnimationEngine, nowMs: number) => GraphAnimationEngine;
export type SelectionBehavior = (model: GraphModel, selection: GraphSelection) => GraphSelection;
export type Exporter = (model: GraphModel) => string;
export interface ValidationIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}
export type Validator = (model: GraphModel) => readonly ValidationIssue[];
export type Decorator = (context: GraphCommandContext) => void;

/**
 * A third-party graph behavior bundle. A plugin declares what it wants to
 * contribute — layouts, commands, animations, selection behaviors,
 * exporters, validators, decorators — and `installPlugin` wires each piece
 * into the corresponding existing registry (`GraphLayouts.register`,
 * `GraphCommandRegistry.register`, ...) via composition. Nothing in this
 * module reaches into or modifies core class internals; a plugin is only
 * ever able to do what those registries' own public `register` methods
 * already allow.
 */
export interface GraphPlugin {
  readonly name: string;
  readonly interactions?: Readonly<Record<string, unknown>>;
  readonly layouts?: readonly LayoutEngine[];
  readonly commands?: Readonly<Record<string, GraphCommandHandler<any>>>;
  readonly animations?: Readonly<Record<string, AnimationFactory>>;
  readonly selectionBehaviors?: Readonly<Record<string, SelectionBehavior>>;
  readonly exporters?: Readonly<Record<string, Exporter>>;
  readonly validators?: Readonly<Record<string, Validator>>;
  readonly decorators?: Readonly<Record<string, Decorator>>;
}

export interface InstallTargets {
  readonly layouts?: GraphLayouts;
  readonly commands?: GraphCommandRegistry;
}

/** Installs a plugin's layouts/commands into the given registries (whichever are supplied), and returns everything the plugin contributed that has no existing registry to live in (animations, selection behaviors, exporters, validators, decorators) so the host can hold onto it. */
export function installPlugin(plugin: GraphPlugin, targets: InstallTargets = {}): void {
  if (plugin.layouts && targets.layouts) {
    for (const layout of plugin.layouts) targets.layouts.register(layout);
  }
  if (plugin.commands && targets.commands) {
    for (const [name, handler] of Object.entries(plugin.commands)) targets.commands.register(name, handler);
  }
}

/**
 * Immutable registry of installed plugins plus everything they
 * contributed that doesn't have a dedicated existing registry
 * (animations/selectionBehaviors/exporters/validators/decorators) —
 * looked up by `${pluginName}:${itemName}`.
 */
export class GraphPluginRegistry {
  private constructor(
    private readonly plugins: ReadonlyMap<string, GraphPlugin>,
    private readonly animations: ReadonlyMap<string, AnimationFactory>,
    private readonly selectionBehaviors: ReadonlyMap<string, SelectionBehavior>,
    private readonly exporters: ReadonlyMap<string, Exporter>,
    private readonly validators: ReadonlyMap<string, Validator>,
    private readonly decorators: ReadonlyMap<string, Decorator>,
  ) {}

  static empty(): GraphPluginRegistry {
    return new GraphPluginRegistry(new Map(), new Map(), new Map(), new Map(), new Map(), new Map());
  }

  register(plugin: GraphPlugin, targets: InstallTargets = {}): GraphPluginRegistry {
    installPlugin(plugin, targets);
    const plugins = new Map(this.plugins).set(plugin.name, plugin);
    const animations = new Map(this.animations);
    const selectionBehaviors = new Map(this.selectionBehaviors);
    const exporters = new Map(this.exporters);
    const validators = new Map(this.validators);
    const decorators = new Map(this.decorators);
    for (const [name, fn] of Object.entries(plugin.animations ?? {})) animations.set(`${plugin.name}:${name}`, fn);
    for (const [name, fn] of Object.entries(plugin.selectionBehaviors ?? {})) selectionBehaviors.set(`${plugin.name}:${name}`, fn);
    for (const [name, fn] of Object.entries(plugin.exporters ?? {})) exporters.set(`${plugin.name}:${name}`, fn);
    for (const [name, fn] of Object.entries(plugin.validators ?? {})) validators.set(`${plugin.name}:${name}`, fn);
    for (const [name, fn] of Object.entries(plugin.decorators ?? {})) decorators.set(`${plugin.name}:${name}`, fn);
    return new GraphPluginRegistry(plugins, animations, selectionBehaviors, exporters, validators, decorators);
  }

  has(pluginName: string): boolean {
    return this.plugins.has(pluginName);
  }

  get pluginNames(): readonly string[] {
    return [...this.plugins.keys()];
  }

  getAnimation(key: string): AnimationFactory | undefined {
    return this.animations.get(key);
  }

  getSelectionBehavior(key: string): SelectionBehavior | undefined {
    return this.selectionBehaviors.get(key);
  }

  getExporter(key: string): Exporter | undefined {
    return this.exporters.get(key);
  }

  getValidator(key: string): Validator | undefined {
    return this.validators.get(key);
  }

  getDecorator(key: string): Decorator | undefined {
    return this.decorators.get(key);
  }

  /** Runs every registered validator against a model and concatenates their issues. */
  validateAll(model: GraphModel): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const validator of this.validators.values()) issues.push(...validator(model));
    return issues;
  }
}
