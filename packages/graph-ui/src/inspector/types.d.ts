import type { EdgeId, NodeId } from '../model/types.js';
/**
 * Pure, immutable contracts for node/edge inspection UIs. Nothing here
 * renders anything — these are just the data shapes a host inspector panel
 * (in Studio, the runtime debugger, etc.) reads to render its own UI.
 *
 * Note: this module's `GraphMetadataEntry` is a display-oriented key/label/
 * value row, distinct from the general-purpose `GraphMetadata` JSON bag
 * exported from the core model — the two are not interchangeable.
 */
export type PropertyKind = 'text' | 'number' | 'boolean' | 'link' | 'code';
export interface GraphProperty {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly kind?: PropertyKind;
}
export interface GraphPropertyGroup {
    readonly id: string;
    readonly label: string;
    readonly properties: readonly GraphProperty[];
}
export interface GraphMetadataEntry {
    readonly key: string;
    readonly label: string;
    readonly value: string;
}
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export interface GraphBadge {
    readonly id: string;
    readonly label: string;
    readonly tone?: BadgeTone;
    readonly icon?: string;
}
export interface GraphTooltip {
    readonly title: string;
    readonly description?: string;
}
export interface GraphOverlay {
    readonly id: string;
    readonly kind: string;
    readonly anchorNodeId?: NodeId;
    readonly anchorEdgeId?: EdgeId;
    readonly content: string;
}
export interface GraphContextMenuItem {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    readonly shortcut?: string;
}
export type GraphContextMenuTargetKind = 'node' | 'edge' | 'canvas';
export interface GraphContextMenu {
    readonly targetKind: GraphContextMenuTargetKind;
    readonly targetId?: NodeId | EdgeId;
    readonly items: readonly GraphContextMenuItem[];
}
export type GraphInspectorTargetKind = 'node' | 'edge' | 'group';
export interface GraphInspectorData {
    readonly targetKind: GraphInspectorTargetKind;
    readonly targetId: string;
    readonly title: string;
    readonly badges: readonly GraphBadge[];
    readonly propertyGroups: readonly GraphPropertyGroup[];
    readonly metadataEntries: readonly GraphMetadataEntry[];
    readonly tooltip?: GraphTooltip;
}
//# sourceMappingURL=types.d.ts.map