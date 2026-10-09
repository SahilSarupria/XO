export interface GraphEdge {
  readonly id: string;
  readonly type: string; // typed relationship, per PACKAGE_README.md ("typed relationships")
  readonly fromId: string;
  readonly toId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}
