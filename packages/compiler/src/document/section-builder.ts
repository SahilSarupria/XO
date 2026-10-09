import type { DocumentBlock, DocumentSection, HeadingBlock } from './types.js';

interface MutableSection {
  heading: HeadingBlock | undefined;
  blocks: DocumentBlock[];
  subsections: MutableSection[];
  level: number; // 0 for the synthetic root
}

function freeze(section: MutableSection): DocumentSection {
  return { heading: section.heading, blocks: section.blocks, subsections: section.subsections.map(freeze) };
}

/**
 * Nests a flat `DocumentBlock` stream into a `DocumentSection` tree: a
 * heading opens a new section that owns every following block until a
 * heading of equal or higher prominence (lower or equal `level`, per
 * font-stats.ts's level assignment) closes it. This is the compiler
 * spec's "Hierarchy" extraction — implemented purely from the heading
 * levels block-builder.ts already assigned, no further classification
 * happens here.
 */
export function buildSections(blocks: readonly DocumentBlock[]): DocumentSection {
  const root: MutableSection = { heading: undefined, blocks: [], subsections: [], level: 0 };
  const stack: MutableSection[] = [root];

  for (const block of blocks) {
    if (block.kind === 'heading') {
      while (stack.length > 1 && stack[stack.length - 1]!.level >= block.level) {
        stack.pop();
      }
      const newSection: MutableSection = { heading: block, blocks: [], subsections: [], level: block.level };
      stack[stack.length - 1]!.subsections.push(newSection);
      stack.push(newSection);
      continue;
    }
    stack[stack.length - 1]!.blocks.push(block);
  }

  return freeze(root);
}
