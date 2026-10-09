import type { GraphRenderAdapter, RenderFrame } from './GraphRenderAdapter.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders a frame to a deterministic SVG markup string. Depends on nothing
 * beyond the DOM-free string builder below, so it works identically in
 * Node (tests, SSR, snapshot export) and the browser. This is the
 * reference adapter implementation — other adapters (Canvas, WebGL, React
 * Flow) implement the same GraphRenderAdapter contract.
 */
export class SvgStringAdapter implements GraphRenderAdapter {
  readonly name = 'svg-string';
  private lastMarkup = '';

  render(frame: RenderFrame): void {
    const edgeMarkup = frame.edges
      .map((e) => {
        const stroke = e.style.stroke ?? '#000';
        const width = e.style.strokeWidth ?? 1;
        const dash = e.style.dashed ? ' stroke-dasharray="4 2"' : '';
        return `<line data-edge-id="${esc(e.edge.id)}" x1="${e.sourcePoint.x}" y1="${e.sourcePoint.y}" x2="${e.targetPoint.x}" y2="${e.targetPoint.y}" stroke="${stroke}" stroke-width="${width}"${dash} />`;
      })
      .join('');

    const nodeMarkup = frame.nodes
      .map((n) => {
        const size = n.node.size ?? { width: 120, height: 40 };
        const fill = n.style.fill ?? '#fff';
        const stroke = n.style.stroke ?? '#000';
        const strokeWidth = n.style.strokeWidth ?? 1;
        const rx = n.style.radius ?? 0;
        return (
          `<g data-node-id="${esc(n.node.id)}" transform="translate(${n.node.position.x},${n.node.position.y})">` +
          `<rect width="${size.width}" height="${size.height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />` +
          `<text x="${size.width / 2}" y="${size.height / 2}" text-anchor="middle" dominant-baseline="middle" fill="${n.style.textColor ?? '#000'}">${esc(n.node.label)}</text>` +
          `</g>`
        );
      })
      .join('');

    this.lastMarkup = `<svg xmlns="http://www.w3.org/2000/svg" style="background:${frame.background}"><g class="graph-ui-edges">${edgeMarkup}</g><g class="graph-ui-nodes">${nodeMarkup}</g></svg>`;
  }

  /** The markup produced by the most recent render() call. */
  toString(): string {
    return this.lastMarkup;
  }

  dispose(): void {
    this.lastMarkup = '';
  }
}
