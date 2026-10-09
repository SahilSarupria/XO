/**
 * Core immutable data model for graph-ui.
 *
 * Nothing in this file knows about rendering, React Flow, the compiler,
 * the runtime, or any business domain. It is pure data.
 */

export type NodeId = string;
export type EdgeId = string;
export type GroupId = string;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

/** Arbitrary JSON-serializable metadata attached to a node/edge/group. */
export type GraphMetadata = Readonly<Record<string, unknown>>;

export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  readonly label: string;
  readonly position: Point;
  readonly size?: Size;
  readonly groupId?: GroupId;
  readonly metadata?: GraphMetadata;
  readonly hidden?: boolean;
}

export interface GraphEdge {
  readonly id: EdgeId;
  readonly type: string;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly label?: string;
  readonly metadata?: GraphMetadata;
  readonly hidden?: boolean;
}

export interface NodeGroup {
  readonly id: GroupId;
  readonly label: string;
  readonly nodeIds: readonly NodeId[];
  readonly collapsed?: boolean;
  readonly metadata?: GraphMetadata;
  /** Optional parent group id, enabling nested groups. Additive/optional —
   * omitting it keeps a group flat, exactly as before this field existed. */
  readonly parentGroupId?: GroupId;
}

export interface EdgeGroup {
  readonly id: GroupId;
  readonly label: string;
  readonly edgeIds: readonly EdgeId[];
  readonly metadata?: GraphMetadata;
}

export interface GraphViewportState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type SelectionKind = 'node' | 'edge' | 'group';

export interface GraphSelectionState {
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly edgeIds: ReadonlySet<EdgeId>;
  readonly groupIds: ReadonlySet<GroupId>;
}

export interface NodeStyle {
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly textColor?: string;
  readonly radius?: number;
  readonly icon?: string;
}

export interface EdgeStyle {
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly dashed?: boolean;
  readonly animated?: boolean;
  readonly arrow?: boolean;
}

export interface GraphThemeDefinition {
  readonly name: string;
  readonly background: string;
  readonly defaultNodeStyle: NodeStyle;
  readonly defaultEdgeStyle: EdgeStyle;
  readonly selectionStyle: { readonly node: NodeStyle; readonly edge: EdgeStyle };
  readonly hoverStyle: { readonly node: NodeStyle; readonly edge: EdgeStyle };
  readonly nodeTypeStyles?: Readonly<Record<string, NodeStyle>>;
  readonly edgeTypeStyles?: Readonly<Record<string, EdgeStyle>>;
  readonly executionStyles?: Readonly<Record<ExecutionNodeStatus, NodeStyle>>;
}

export type ExecutionNodeStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface GraphFilterState {
  readonly nodeTypes?: ReadonlySet<string>;
  readonly edgeTypes?: ReadonlySet<string>;
  readonly labelQuery?: string;
  readonly metadataPredicate?: (metadata: GraphMetadata | undefined) => boolean;
  readonly hiddenNodeIds?: ReadonlySet<NodeId>;
  readonly hiddenEdgeIds?: ReadonlySet<EdgeId>;
  readonly collapsedGroupIds?: ReadonlySet<GroupId>;
}

export interface GraphSearchMatch {
  readonly kind: 'node' | 'edge';
  readonly id: NodeId | EdgeId;
  readonly field: 'label' | 'id' | 'metadata';
  readonly matchedValue: string;
}

export interface GraphSearchResultState {
  readonly query: string;
  readonly matches: readonly GraphSearchMatch[];
  readonly activeIndex: number;
}

export interface LayoutPosition {
  readonly id: NodeId;
  readonly position: Point;
}

export type LayoutKind =
  | 'hierarchical'
  | 'dag'
  | 'tree'
  | 'force-directed'
  | 'circular'
  | 'grid'
  | 'manual';

export interface GraphLayoutResult {
  readonly kind: LayoutKind;
  readonly positions: readonly LayoutPosition[];
}

export interface GraphLayoutOptions {
  readonly seed?: NodeId;
  readonly spacingX?: number;
  readonly spacingY?: number;
  readonly iterations?: number;
  readonly columns?: number;
  readonly radius?: number;
  readonly direction?: 'TB' | 'LR';
}
