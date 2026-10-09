function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Computes the bounding rect of everything in a frame (nodes + edge endpoints), in world space. */
export function computeContentBounds(frame) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of frame.nodes) {
        const size = n.node.size ?? { width: 120, height: 40 };
        minX = Math.min(minX, n.node.position.x);
        minY = Math.min(minY, n.node.position.y);
        maxX = Math.max(maxX, n.node.position.x + size.width);
        maxY = Math.max(maxY, n.node.position.y + size.height);
    }
    for (const e of frame.edges) {
        minX = Math.min(minX, e.sourcePoint.x, e.targetPoint.x);
        minY = Math.min(minY, e.sourcePoint.y, e.targetPoint.y);
        maxX = Math.max(maxX, e.sourcePoint.x, e.targetPoint.x);
        maxY = Math.max(maxY, e.sourcePoint.y, e.targetPoint.y);
    }
    if (!isFinite(minX))
        return { x: 0, y: 0, width: 1, height: 1 };
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
/**
 * Renders a RenderFrame to a standalone, deterministic SVG document string.
 * Pure function — no DOM, no adapter, safe to call in Node or the browser.
 * This is what backs `exportToSvg`/`exportToPrintSvg`/PNG export (which
 * rasterizes this markup via a host-supplied rasterizer).
 */
export function exportToSvg(frame, options = {}) {
    const bounds = computeContentBounds(frame);
    const padding = options.padding ?? 24;
    const viewBox = `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`;
    const width = options.width ?? bounds.width + padding * 2;
    const height = options.height ?? bounds.height + padding * 2;
    const edgeMarkup = frame.edges
        .map((e) => {
        const stroke = e.style.stroke ?? '#000';
        const strokeWidth = e.style.strokeWidth ?? 1;
        const dash = e.style.dashed ? ' stroke-dasharray="4 2"' : '';
        return `<line data-edge-id="${esc(e.edge.id)}" x1="${e.sourcePoint.x}" y1="${e.sourcePoint.y}" x2="${e.targetPoint.x}" y2="${e.targetPoint.y}" stroke="${stroke}" stroke-width="${strokeWidth}"${dash} />`;
    })
        .join('');
    const nodeMarkup = frame.nodes
        .map((n) => {
        const size = n.node.size ?? { width: 120, height: 40 };
        const fill = n.style.fill ?? '#fff';
        const stroke = n.style.stroke ?? '#000';
        const strokeWidth = n.style.strokeWidth ?? 1;
        const rx = n.style.radius ?? 0;
        return (`<g data-node-id="${esc(n.node.id)}" transform="translate(${n.node.position.x},${n.node.position.y})">` +
            `<rect width="${size.width}" height="${size.height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />` +
            `<text x="${size.width / 2}" y="${size.height / 2}" text-anchor="middle" dominant-baseline="middle" fill="${n.style.textColor ?? '#000'}">${esc(n.node.label)}</text>` +
            `</g>`);
    })
        .join('');
    return (`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" style="background:${frame.background}">` +
        `<g class="graph-ui-edges">${edgeMarkup}</g><g class="graph-ui-nodes">${nodeMarkup}</g></svg>`);
}
//# sourceMappingURL=toSvg.js.map