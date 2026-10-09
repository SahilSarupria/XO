import { GraphCamera } from './GraphCamera.js';
import type { GraphViewportState } from '../model/types.js';
/**
 * Holds multiple named cameras (e.g. a main view + a minimap + a
 * picture-in-picture), with optional "linking": panning or zooming a
 * linked camera applies the same delta to every other linked camera,
 * keeping them synchronized (useful for split views following the same
 * region, or a main view + minimap that stay in lockstep).
 */
export declare class GraphCameraGroup {
    private readonly cameras;
    private readonly linked;
    private constructor();
    static empty(): GraphCameraGroup;
    addCamera(name: string, camera?: GraphCamera): GraphCameraGroup;
    removeCamera(name: string): GraphCameraGroup;
    getCamera(name: string): GraphCamera | undefined;
    get cameraNames(): readonly string[];
    link(name: string): GraphCameraGroup;
    unlink(name: string): GraphCameraGroup;
    isLinked(name: string): boolean;
    /** Pans one camera by (dx, dy); if it's linked, every other linked camera is panned by the same amount, keeping them in sync. */
    pan(name: string, dx: number, dy: number): GraphCameraGroup;
    /** Zooms one camera by `factor`; propagates to other linked cameras the same way pan() does. */
    zoomBy(name: string, factor: number): GraphCameraGroup;
    setCameraState(name: string, state: GraphViewportState): GraphCameraGroup;
}
//# sourceMappingURL=GraphCameraGroup.d.ts.map