import type { GraphLayouts } from '../layout/GraphLayouts.js';
import type { LayoutEngine } from '../layout/types.js';
import type { GraphCommandRegistry } from '../commands/GraphCommandRegistry.js';
import type { GraphCommandContext, GraphCommandHandler } from '../commands/types.js';
import type { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
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
export declare function installPlugin(plugin: GraphPlugin, targets?: InstallTargets): void;
/**
 * Immutable registry of installed plugins plus everything they
 * contributed that doesn't have a dedicated existing registry
 * (animations/selectionBehaviors/exporters/validators/decorators) —
 * looked up by `${pluginName}:${itemName}`.
 */
export declare class GraphPluginRegistry {
    private readonly plugins;
    private readonly animations;
    private readonly selectionBehaviors;
    private readonly exporters;
    private readonly validators;
    private readonly decorators;
    private constructor();
    static empty(): GraphPluginRegistry;
    register(plugin: GraphPlugin, targets?: InstallTargets): GraphPluginRegistry;
    has(pluginName: string): boolean;
    get pluginNames(): readonly string[];
    getAnimation(key: string): AnimationFactory | undefined;
    getSelectionBehavior(key: string): SelectionBehavior | undefined;
    getExporter(key: string): Exporter | undefined;
    getValidator(key: string): Validator | undefined;
    getDecorator(key: string): Decorator | undefined;
    /** Runs every registered validator against a model and concatenates their issues. */
    validateAll(model: GraphModel): readonly ValidationIssue[];
}
//# sourceMappingURL=GraphPluginRegistry.d.ts.map