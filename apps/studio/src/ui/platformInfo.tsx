import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PlatformVersion } from '../platform/client';
import { SUPPORTED_API, supportsApi } from '../platform/build';
import { useSession } from './session';

/**
 * S1-3 (plan 6.3): Studio asks the API which version it is and which optional parts it offers, once per sign-in.
 * - A version this Studio does not support stops Studio with a calm full-screen message, instead of screens failing oddly.
 * - A part the instance does not offer (Connect) is not asked for, and its screen says it is not available here.
 * - An API that cannot say (older, or unreachable just now) is treated as before: everything is offered and the API decides.
 */
export interface PlatformFeatures {
  readonly connect: boolean;
}
const ALL: PlatformFeatures = { connect: true };
const FeaturesContext = createContext<PlatformFeatures>(ALL);
export const usePlatformFeatures = (): PlatformFeatures => useContext(FeaturesContext);

export function PlatformGate(props: { children: ReactNode }) {
  const { client } = useSession();
  const [info, setInfo] = useState<PlatformVersion | undefined>();
  useEffect(() => {
    let live = true;
    void client.getVersion().then((r) => {
      if (live && r.ok) setInfo(r.value);
    });
    return () => {
      live = false;
    };
  }, [client]);
  if (info !== undefined && !supportsApi(info.version)) return <VersionMismatch api={info.version} />;
  return (
    <FeaturesContext.Provider value={info === undefined ? ALL : { connect: info.features.connect }}>
      {props.children}
    </FeaturesContext.Provider>
  );
}

function VersionMismatch(props: { api: string }) {
  return (
    <main className="recover recover-full" aria-labelledby="mismatch-h">
      <span className="brand-mark" aria-hidden="true" />
      <h1 id="mismatch-h">XO is being updated</h1>
      <p className="muted">Try again in a few minutes. Your work is safe and nothing was changed.</p>
      <p className="muted small">
        If you look after this XO: this Studio needs XO {SUPPORTED_API}, and the service reports {props.api}. Update Studio or the service
        so they match.
      </p>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </main>
  );
}
