import type { ReactElement } from 'react';
import { ShellProvider, createWebShellServices, type ShellServices } from '../src/shell/services';

/** Wrap a UI under test with shell services; tests may substitute their own. */
export function withShell(ui: ReactElement, services: ShellServices = createWebShellServices()): ReactElement {
  return <ShellProvider services={services}>{ui}</ShellProvider>;
}
