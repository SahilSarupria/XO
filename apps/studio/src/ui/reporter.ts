import { createContext, useContext } from 'react';
import type { ErrorReporter } from '../platform/errorReport';

/** The signed-in session's error reporter, so a screen's own boundary can report too. Absent outside a session. */
export const ReporterContext = createContext<ErrorReporter | undefined>(undefined);
export const useReporter = (): ErrorReporter | undefined => useContext(ReporterContext);
