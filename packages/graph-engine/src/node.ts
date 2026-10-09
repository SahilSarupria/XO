export interface GraphNode {
  readonly id: string;
  readonly type: string; // e.g. one of the 8 document types / 22 clause types in PACKAGE_README.md's knowledge graph
  readonly properties: Readonly<Record<string, unknown>>;
}
