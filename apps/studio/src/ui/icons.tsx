export type IconName =
  'home' | 'workspaces' | 'work' | 'tasks' | 'activity' | 'setup' | 'processes' | 'menu' | 'check' | 'user' | 'file' | 'play';

const PATHS: Record<IconName, string> = {
  workspaces: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  work: 'M5 4v16M5 6h11l-2 3 2 3H5',
  tasks: 'M9 11l3 3 8-9M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  setup: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  processes: 'M6 5a2 2 0 1 0 0 .01M6 19a2 2 0 1 0 0 .01M18 12a2 2 0 1 0 0 .01M8 6l8 5M8 18l8-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  check: 'M5 12l5 5 9-11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5',
  play: 'M7 4l13 8-13 8z',
};

/** Decorative only: every use sits next to visible text, so it is hidden from assistive technology. */
export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 20;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
