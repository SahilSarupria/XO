import type { Mode } from './session';
import type { Section } from './sectionRoute';

/**
 * S1-3 (plan 3): Studio's seven places. Builder mode adds views inside a place; it never adds a place. Each place lists the
 * screens it holds, in tab order; the first is where the place opens.
 */
export type Place = 'home' | 'inbox' | 'work' | 'sources' | 'knowledge' | 'activity' | 'settings';

export interface PlaceView {
  readonly section: Section;
  readonly label: string;
  readonly builderOnly?: boolean;
}

export interface PlaceInfo {
  readonly id: Place;
  readonly label: string;
  readonly hint: string;
  readonly views: readonly PlaceView[];
  /** Screens that belong to the place but are reached from inside it (not tabs). */
  readonly also?: readonly Section[];
}

export const PLACES: readonly PlaceInfo[] = [
  { id: 'home', label: 'Home', hint: 'What needs you now', views: [{ section: 'home', label: 'Home' }], also: ['chat'] },
  { id: 'inbox', label: 'Inbox', hint: 'Everything waiting for a person', views: [{ section: 'tasks', label: 'Inbox' }] },
  {
    id: 'work',
    label: 'Work',
    hint: 'Your workflows: start, preview, approve',
    views: [
      { section: 'work', label: 'Workflows' },
      { section: 'library', label: 'Library' },
      { section: 'processes', label: 'Processes', builderOnly: true },
    ],
    also: ['graph', 'executions'],
  },
  {
    id: 'sources',
    label: 'Sources',
    hint: 'Documents, folders and what XO found in them',
    views: [
      { section: 'setup', label: 'Documents and rules' },
      { section: 'connect', label: 'Connections' },
      { section: 'contracts', label: 'Contracts', builderOnly: true },
    ],
    also: ['create', 'xo'],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    hint: 'What XO knows, and what waits for review',
    views: [
      { section: 'whatxoknows', label: 'What XO knows' },
      { section: 'knowledge', label: 'Records' },
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    hint: 'What has run, and who did what',
    views: [
      { section: 'activity', label: 'Runs' },
      { section: 'audit', label: 'Audit log' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Workspace, members, connections and appearance',
    views: [
      { section: 'settings', label: 'Settings' },
      { section: 'workspaces', label: 'All workspaces' },
      { section: 'platform', label: 'Platform', builderOnly: true },
    ],
  },
];

const BY_SECTION = new Map<Section, PlaceInfo>();
for (const p of PLACES) for (const s of [...p.views.map((v) => v.section), ...(p.also ?? [])]) BY_SECTION.set(s, p);

export function placeOf(section: Section): PlaceInfo {
  return BY_SECTION.get(section) ?? PLACES[0]!;
}

/** The tabs a place shows in this mode (none when it has only one view). */
export function viewsOf(place: PlaceInfo, mode: Mode): readonly PlaceView[] {
  const views = place.views.filter((v) => v.builderOnly !== true || mode === 'builder');
  return views.length > 1 ? views : [];
}
