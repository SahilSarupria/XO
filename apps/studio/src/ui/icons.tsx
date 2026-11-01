export type IconName =
  | 'home'
  | 'workspaces'
  | 'work'
  | 'tasks'
  | 'activity'
  | 'setup'
  | 'processes'
  | 'contracts'
  | 'platform'
  | 'inbox'
  | 'xos'
  | 'library'
  | 'audit'
  | 'settings'
  | 'menu'
  | 'check'
  | 'user'
  | 'file'
  | 'play'
  | 'bolt'
  | 'split'
  | 'plus'
  | 'upload'
  | 'link'
  | 'text'
  | 'search'
  | 'minus'
  | 'fit'
  | 'image'
  | 'table'
  | 'code'
  | 'x';

const PATHS: Record<IconName, string> = {
  workspaces: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  work: 'M5 4v16M5 6h11l-2 3 2 3H5',
  tasks: 'M9 11l3 3 8-9M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  setup: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  processes: 'M6 5a2 2 0 1 0 0 .01M6 19a2 2 0 1 0 0 .01M18 12a2 2 0 1 0 0 .01M8 6l8 5M8 18l8-5',
  contracts: 'M7 4h10v16H7zM10 8h4M10 12h4M10 16h2',
  xos: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12v9M4 7.5L12 12l8-4.5',
  inbox: 'M3 7h18v12H3zM3 7l9 7 9-7',
  library: 'M4 4h6v16H4zM12 4h8v7h-8zM12 13h8v7h-8z',
  audit: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
  platform: 'M4 6h16v5H4zM4 13h16v5H4zM8 8.5h.01M8 15.5h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  check: 'M5 12l5 5 9-11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5',
  play: 'M7 4l13 8-13 8z',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  split: 'M6 4v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v2M18 4v6M6 4h.01M18 4h.01M18 20h.01',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  text: 'M5 6h14M5 11h14M5 16h9',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  code: 'M9 8l-5 4 5 4M15 8l5 4-5 4',
  x: 'M6 6l12 12M18 6L6 18',
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
