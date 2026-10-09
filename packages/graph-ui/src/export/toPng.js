import { exportToSvg } from './toSvg.js';
export async function exportToPng(frame, rasterize, options = {}) {
    const svg = exportToSvg(frame, options);
    const bounds = svgDimensions(svg);
    return rasterize(svg, bounds);
}
function svgDimensions(svg) {
    const widthMatch = /width="([\d.]+)"/.exec(svg);
    const heightMatch = /height="([\d.]+)"/.exec(svg);
    return {
        width: widthMatch ? Number(widthMatch[1]) : 0,
        height: heightMatch ? Number(heightMatch[1]) : 0,
    };
}
//# sourceMappingURL=toPng.js.map