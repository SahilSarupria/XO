import { lazy, type ComponentType, type ReactElement } from 'react';

/**
 * S1-3 (budgets, handoff 3.8): each place's screens are their own chunk. `lazyScreen` is React.lazy that, once the chunk has
 * loaded, renders synchronously (no second Suspense pass), and can be preloaded: Studio preloads every place when the browser is
 * idle after the first screen, so moving between places does not wait. Tests preload before they start (test/setup.ts).
 */
type Loader<P> = () => Promise<ComponentType<P>>;
export interface LazyScreen<P> {
  (props: P): ReactElement;
  preload: () => Promise<void>;
}
const all: (() => Promise<void>)[] = [];

export function lazyScreen<P extends object>(load: Loader<P>): LazyScreen<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const get = () => (pending ??= load().then((c) => (loaded = c)));
  const Lazy = lazy(() => get().then((c) => ({ default: c })));
  const Screen = ((props: P) => {
    const C = loaded;
    if (C !== undefined) return <C {...props} />;
    const L = Lazy as unknown as ComponentType<P>;
    return <L {...props} />;
  }) as LazyScreen<P>;
  Screen.preload = () => get().then(() => undefined);
  all.push(Screen.preload);
  return Screen;
}

/** Loads every screen registered so far (after the first screen, when the browser is idle; and in tests). */
export function preloadScreens(): Promise<void> {
  return Promise.all(all.map((p) => p())).then(() => undefined);
}
