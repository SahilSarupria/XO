import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { KIND_LABEL, openOutputs } from '../domain/draftEdit';
import { layoutFlow, type FlowNode } from '../domain/flowLayout';
import { tidyName } from '../domain/work';
import type { DraftNodeKind } from '../platform/wire-studio';
import { Icon, type IconName } from './icons';
import type { DraftController } from './useWorkflowDraft';

/** Where a new step would be inserted: on the connection leaving `from` (on one side of it, for a branch). */
export interface InsertTarget {
  readonly from: string;
  readonly when?: 'gte' | 'lt';
}
export interface NodeBadge {
  readonly text: string;
  readonly tone: 'warning' | 'neutral';
}

const KIND_ICON: Readonly<Record<DraftNodeKind, IconName>> = {
  trigger: 'bolt',
  capability: 'xos',
  branch: 'split',
  human_review: 'user',
  compile: 'code',
  validate: 'check',
  action: 'play',
};
const SIDE_TEXT = { gte: 'at or above', lt: 'below' } as const;

const MIN_K = 0.3;
const MAX_K = 1.8;
const MARGIN = 28;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

/** The view that shows the whole drawing, never magnified past 100%. With nothing measured yet (no layout) it is the plain 100% view. */
export function fitView(content: { width: number; height: number }, port: { width: number; height: number }, minK = MIN_K): View {
  if (port.width <= 0 || port.height <= 0 || content.width <= 0 || content.height <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampK(Math.max(minK, Math.min(1, (port.width - 2 * MARGIN) / content.width, (port.height - 2 * MARGIN) / content.height)));
  return {
    x: Math.max(MARGIN, (port.width - content.width * k) / 2),
    y: Math.max(MARGIN, (port.height - content.height * k) / 2),
    k,
  };
}
/** Opening a draft never shrinks it below this: a long process opens readable at its start, and the minimap and Fit show the rest. */
const OPEN_MIN_K = 0.7;
/** Zooms by `factor`, keeping the point under (cx, cy) where it is. */
export function zoomAt(v: View, factor: number, cx: number, cy: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
}

/**
 * The workflow drawn as a node graph: cards with ports, smooth connections with arrowheads, an insert control on every
 * connection and an add stub wherever a path ends. Drag the background (or scroll) to pan; Ctrl/⌘ + scroll or the
 * buttons to zoom. Positions are always derived from the graph, so nothing here is saved or invented: every change goes
 * through the draft's own edit operations and the platform's validation.
 */
export function FlowCanvas(props: {
  draft: DraftController;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  canEdit: boolean;
  badges?: ReadonlyMap<string, NodeBadge>;
  insertTarget?: InsertTarget | undefined;
  onInsert: (t: InsertTarget) => void;
}) {
  const d = props.draft;
  const layout = useMemo(() => layoutFlow({ nodes: d.nodes, edges: d.edges }), [d.nodes, d.edges]);
  const g = useMemo(() => ({ nodes: d.nodes, edges: d.edges }), [d.nodes, d.edges]);
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [anim, setAnim] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<string | undefined>();
  const [port, setPort] = useState({ width: 0, height: 0 });
  const touched = useRef(false); // true once the person has moved the view themselves; auto-fit then stays out of the way
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const measure = useCallback(() => {
    const el = viewport.current;
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
  }, []);
  /** `all` shows the whole drawing however small that makes it (the Fit button); otherwise it opens readable (see OPEN_MIN_K). */
  const fit = useCallback(
    (animate: boolean, all = false) => {
      touched.current = false;
      setAnim(animate);
      setView(fitView(layoutRef.current, measure(), all ? MIN_K : OPEN_MIN_K));
    },
    [measure],
  );

  // Fit once the viewport has a size, and again whenever another draft is opened.
  useLayoutEffect(() => {
    setPort(measure());
    fit(false);
  }, [d.definitionId, fit, measure]);
  useEffect(() => {
    const el = viewport.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const m = measure();
      setPort(m);
      if (!touched.current) setView(fitView(layoutRef.current, m, OPEN_MIN_K));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Wheel: scroll pans, Ctrl/⌘ + scroll (and a trackpad pinch) zooms at the pointer. Must be non-passive to stop the page scrolling.
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.nf-minimap, .nf-controls') !== null) return;
      e.preventDefault();
      touched.current = true;
      setAnim(false);
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Bring a newly selected node into view if it is off screen.
  const lastSelected = useRef(props.selectedId);
  useEffect(() => {
    if (props.selectedId === lastSelected.current) return;
    lastSelected.current = props.selectedId;
    const m = measure();
    const n = layoutRef.current.nodes.find((p) => p.node.id === props.selectedId);
    if (n === undefined || m.width <= 0) return;
    const v = viewRef.current;
    const left = n.x * v.k + v.x;
    const top = n.y * v.k + v.y;
    const out = left < 16 || top < 16 || left + n.w * v.k > m.width - 16 || top + n.h * v.k > m.height - 16;
    if (!out) return;
    touched.current = true;
    setAnim(true);
    setView({ k: v.k, x: m.width / 2 - (n.x + n.w / 2) * v.k, y: m.height / 2 - (n.y + n.h / 2) * v.k });
  }, [props.selectedId, measure]);

  const zoomBy = (factor: number) => {
    const m = measure();
    touched.current = true;
    setAnim(true);
    setView((v) => zoomAt(v, factor, m.width / 2, m.height / 2));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, .nf-minimap, .nf-controls') !== null) return;
    drag.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = drag.current;
    if (s === undefined) return;
    const dx = e.clientX - s.sx;
    const dy = e.clientY - s.sy;
    if (!s.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    s.moved = true;
    touched.current = true;
    setAnim(false);
    setPanning(true);
    setView((v) => ({ ...v, x: s.vx + dx, y: s.vy + dy }));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === undefined) return;
    drag.current = undefined;
    setPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select') !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.2);
    else if (e.key === '0') fit(true, true);
    else return;
    e.preventDefault();
  };

  const active = new Set<string>(props.selectedId !== undefined ? [props.selectedId] : []);
  const label = (id: string) => tidyName(d.nodes.find((n) => n.id === id)?.label ?? id, 40);
  const nodeCount = d.nodes.length;

  return (
    <div
      ref={viewport}
      className="nf"
      data-panning={panning}
      // The dot grid moves and scales with the drawing, so panning and zooming read as moving over a surface.
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.k}px ${22 * view.k}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <div
        className="nf-world"
        data-zoom={view.k.toFixed(2)}
        data-anim={anim}
        style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="nf-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="nf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 1 1 L 9 5 L 1 9 z" className="nf-arrow" />
            </marker>
            <marker id="nf-arrow-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 1 1 L 9 5 L 1 9 z" className="nf-arrow nf-arrow-on" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const on = active.has(e.from) || active.has(e.to);
            return (
              <g key={e.id} data-active={on} data-hover={hoverEdge === e.id}>
                <path className="nf-edge" d={e.path} markerEnd={`url(#${on ? 'nf-arrow-on' : 'nf-arrow'})`} />
                <path
                  className="nf-edge-hit"
                  d={e.path}
                  onPointerEnter={() => setHoverEdge(e.id)}
                  onPointerLeave={() => setHoverEdge((h) => (h === e.id ? undefined : h))}
                />
              </g>
            );
          })}
          {props.canEdit
            ? layout.nodes.flatMap((p) =>
                openOutputs(g, p.node.id).map((side) => {
                  const o = p.outputs.find((x) => x.side === side) ?? p.outputs[0]!;
                  return <path key={`${p.node.id}-${side ?? 'out'}`} className="nf-stub" d={`M ${o.x} ${o.y} H ${o.x + 52}`} />;
                }),
              )
            : null}
        </svg>

        <ol className="nf-nodes" aria-label="Steps in the draft">
          {layout.nodes.map((p) => (
            <FlowNodeCard
              key={p.node.id}
              p={p}
              selected={props.selectedId === p.node.id}
              issues={d.issuesByNode.get(p.node.id)?.length ?? 0}
              badge={props.badges?.get(p.node.id)}
              onSelect={props.onSelect}
            />
          ))}
        </ol>

        {props.canEdit ? (
          <div className="nf-adds" role="group" aria-label="Add or insert a step">
            {layout.edges.map((e) => {
              const target: InsertTarget = e.when !== undefined ? { from: e.from, when: e.when } : { from: e.from };
              const open = isTarget(props.insertTarget, target);
              return (
                <button
                  key={e.id}
                  type="button"
                  className="nf-add"
                  data-show={hoverEdge === e.id || open}
                  data-active={open}
                  style={{ left: e.mid.x, top: e.mid.y }}
                  aria-label={`Insert a step after ${label(e.from)}${e.when !== undefined ? ` (${SIDE_TEXT[e.when]})` : ''}`}
                  onPointerEnter={() => setHoverEdge(e.id)}
                  onPointerLeave={() => setHoverEdge((h) => (h === e.id ? undefined : h))}
                  onClick={() => props.onInsert(target)}
                >
                  <Icon name="plus" size={14} />
                </button>
              );
            })}
            {layout.nodes.flatMap((p) =>
              openOutputs(g, p.node.id).map((side) => {
                const o = p.outputs.find((x) => x.side === side) ?? p.outputs[0]!;
                const target: InsertTarget = side !== undefined ? { from: p.node.id, when: side } : { from: p.node.id };
                const open = isTarget(props.insertTarget, target);
                return (
                  <button
                    key={`${p.node.id}-${side ?? 'out'}`}
                    type="button"
                    className="nf-add nf-add-stub"
                    data-show="true"
                    data-active={open}
                    style={{ left: o.x + 52, top: o.y }}
                    aria-label={`Add a step after ${label(p.node.id)}${side !== undefined ? ` (${SIDE_TEXT[side]})` : ''}`}
                    onClick={() => props.onInsert(target)}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                );
              }),
            )}
          </div>
        ) : null}
      </div>

      {layout.nodes.length >= 5 && port.width > 0 ? (
        <Minimap
          layout={layout}
          view={view}
          port={port}
          onJump={(v) => {
            touched.current = true;
            setAnim(true);
            setView(v);
          }}
        />
      ) : null}

      <div className="nf-controls" role="group" aria-label="Canvas controls">
        <button type="button" className="nf-ctl" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <Icon name="minus" size={14} />
        </button>
        <span className="nf-zoom" aria-hidden="true">
          {Math.round(view.k * 100)}%
        </span>
        <button type="button" className="nf-ctl" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="nf-ctl nf-fit" onClick={() => fit(true, true)}>
          <Icon name="fit" size={14} />
          Fit
        </button>
        <span className="nf-chip">{`${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}`}</span>
        <span className="nf-chip" data-dirty={d.dirty}>
          {d.dirty ? 'Unsaved changes' : 'Saved'}
        </span>
      </div>
      <p className="nf-hint" aria-hidden="true">
        Drag the background or scroll to pan · Ctrl/⌘ + scroll to zoom
      </p>
    </div>
  );
}

const isTarget = (a: InsertTarget | undefined, b: InsertTarget) => a !== undefined && a.from === b.from && a.when === b.when;

function FlowNodeCard(props: {
  p: FlowNode;
  selected: boolean;
  issues: number;
  badge: NodeBadge | undefined;
  onSelect: (id: string) => void;
}) {
  const { p } = props;
  const node = p.node;
  const kind = KIND_LABEL[node.kind];
  const name = node.label ?? kind;
  return (
    <li style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
      <button
        type="button"
        className="nf-node"
        data-kind={node.kind === 'human_review' ? 'human' : node.kind}
        data-issues={props.issues > 0}
        aria-pressed={props.selected}
        aria-label={`${name} (${kind})${props.issues > 0 ? `, ${props.issues} ${props.issues === 1 ? 'problem' : 'problems'}` : ''}`}
        onClick={() => props.onSelect(node.id)}
      >
        <span className="nf-icon" aria-hidden="true">
          <Icon name={KIND_ICON[node.kind]} size={20} />
        </span>
        <span className="nf-text">
          <span className="nf-node-name" title={name}>
            {tidyName(name, 40)}
          </span>
          <span className="nf-node-sub">{kind}</span>
        </span>
        {props.issues > 0 ? (
          <span className="nf-issue" aria-hidden="true">
            {props.issues}
          </span>
        ) : null}
        {props.badge !== undefined ? (
          <span className="nf-badge" data-tone={props.badge.tone} aria-hidden="true">
            {props.badge.text}
          </span>
        ) : null}
      </button>
      {node.kind !== 'trigger' ? <span className="nf-port nf-port-in" style={{ top: p.input.y - p.y }} aria-hidden="true" /> : null}
      {p.outputs.map((o) => (
        <span key={o.side ?? 'out'} className="nf-port nf-port-out" style={{ top: o.y - p.y }} aria-hidden="true" />
      ))}
      {node.kind === 'branch'
        ? p.outputs.map((o) => (
            <span key={`l-${o.side}`} className="nf-side" style={{ top: o.y - p.y }}>
              {o.side === 'gte' ? 'at or above' : 'below'}
            </span>
          ))
        : null}
    </li>
  );
}

function Minimap(props: {
  layout: { nodes: readonly FlowNode[]; width: number; height: number };
  view: View;
  port: { width: number; height: number };
  onJump: (v: View) => void;
}) {
  const { layout, view, port } = props;
  const W = 168;
  const scale = Math.min(W / layout.width, 104 / layout.height);
  const w = layout.width * scale;
  const h = layout.height * scale;
  const vx = (-view.x / view.k) * scale;
  const vy = (-view.y / view.k) * scale;
  const vw = (port.width / view.k) * scale;
  const vh = (port.height / view.k) * scale;
  return (
    <svg
      className="nf-minimap"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const wx = (e.clientX - r.left) / scale;
        const wy = (e.clientY - r.top) / scale;
        props.onJump({ k: view.k, x: port.width / 2 - wx * view.k, y: port.height / 2 - wy * view.k });
      }}
    >
      {layout.nodes.map((n) => (
        <rect
          key={n.node.id}
          className="nf-mini-node"
          data-kind={n.node.kind === 'human_review' ? 'human' : n.node.kind}
          x={n.x * scale}
          y={n.y * scale}
          width={n.w * scale}
          height={n.h * scale}
          rx={2}
        />
      ))}
      <rect className="nf-mini-view" x={vx} y={vy} width={vw} height={vh} />
    </svg>
  );
}
