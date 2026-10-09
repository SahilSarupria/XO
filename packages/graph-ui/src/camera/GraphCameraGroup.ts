import { GraphCamera } from './GraphCamera.js';
import type { GraphViewportState } from '../model/types.js';

/**
 * Holds multiple named cameras (e.g. a main view + a minimap + a
 * picture-in-picture), with optional "linking": panning or zooming a
 * linked camera applies the same delta to every other linked camera,
 * keeping them synchronized (useful for split views following the same
 * region, or a main view + minimap that stay in lockstep).
 */
export class GraphCameraGroup {
  private constructor(
    private readonly cameras: ReadonlyMap<string, GraphCamera>,
    private readonly linked: ReadonlySet<string>,
  ) {}

  static empty(): GraphCameraGroup {
    return new GraphCameraGroup(new Map(), new Set());
  }

  addCamera(name: string, camera: GraphCamera = GraphCamera.create()): GraphCameraGroup {
    const next = new Map(this.cameras);
    next.set(name, camera);
    return new GraphCameraGroup(next, this.linked);
  }

  removeCamera(name: string): GraphCameraGroup {
    if (!this.cameras.has(name)) return this;
    const cameras = new Map(this.cameras);
    cameras.delete(name);
    const linked = new Set(this.linked);
    linked.delete(name);
    return new GraphCameraGroup(cameras, linked);
  }

  getCamera(name: string): GraphCamera | undefined {
    return this.cameras.get(name);
  }

  get cameraNames(): readonly string[] {
    return [...this.cameras.keys()];
  }

  link(name: string): GraphCameraGroup {
    if (!this.cameras.has(name) || this.linked.has(name)) return this;
    return new GraphCameraGroup(this.cameras, new Set([...this.linked, name]));
  }

  unlink(name: string): GraphCameraGroup {
    if (!this.linked.has(name)) return this;
    const linked = new Set(this.linked);
    linked.delete(name);
    return new GraphCameraGroup(this.cameras, linked);
  }

  isLinked(name: string): boolean {
    return this.linked.has(name);
  }

  /** Pans one camera by (dx, dy); if it's linked, every other linked camera is panned by the same amount, keeping them in sync. */
  pan(name: string, dx: number, dy: number): GraphCameraGroup {
    const source = this.cameras.get(name);
    if (!source) return this;
    const next = new Map(this.cameras);
    next.set(name, source.pan(dx, dy));
    if (this.linked.has(name)) {
      for (const other of this.linked) {
        if (other === name) continue;
        const cam = next.get(other);
        if (cam) next.set(other, cam.pan(dx, dy));
      }
    }
    return new GraphCameraGroup(next, this.linked);
  }

  /** Zooms one camera by `factor`; propagates to other linked cameras the same way pan() does. */
  zoomBy(name: string, factor: number): GraphCameraGroup {
    const source = this.cameras.get(name);
    if (!source) return this;
    const next = new Map(this.cameras);
    next.set(name, source.zoomBy(factor));
    if (this.linked.has(name)) {
      for (const other of this.linked) {
        if (other === name) continue;
        const cam = next.get(other);
        if (cam) next.set(other, cam.zoomBy(factor));
      }
    }
    return new GraphCameraGroup(next, this.linked);
  }

  setCameraState(name: string, state: GraphViewportState): GraphCameraGroup {
    if (!this.cameras.has(name)) return this;
    const next = new Map(this.cameras);
    next.set(name, GraphCamera.create(state));
    return new GraphCameraGroup(next, this.linked);
  }
}
