import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource, SourceType } from './types.js';

/**
 * Resolves an `unknown` input (or an explicit `SourceType`) to a
 * `CanonicalSource` without the caller — or any Stage 1-7 code — ever
 * writing `if (sourceType === 'pdf') ... else if (...)`. Registration
 * order is insertion order and does not affect resolution by explicit
 * `sourceType` (`resolve`, a plain map lookup); it only matters for
 * `detect`'s fallback probing, and even there resolution is
 * deterministic for a given registry instance and registration order
 * (Stage 8 §5's "deterministic resolution").
 */
export class SourceFrontendRegistry {
  private readonly frontends = new Map<SourceType, SourceFrontend>();
  private readonly registrationOrder: SourceType[] = [];

  /** Throws (a programmer error, not a runtime data problem) if a frontend for this `sourceType` is already registered — silently overwriting one frontend with another would make `detect`'s resolution order-dependent in a way that's invisible at the call site. Re-registering the *same* frontend instance is still rejected; callers that want to replace a frontend must build a fresh registry. */
  register(frontend: SourceFrontend): void {
    if (this.frontends.has(frontend.sourceType)) {
      throw new SourceError(ErrorCode.ALREADY_EXISTS, `A source frontend for type "${frontend.sourceType}" is already registered`, {
        context: { sourceType: frontend.sourceType },
      });
    }
    this.frontends.set(frontend.sourceType, frontend);
    this.registrationOrder.push(frontend.sourceType);
  }

  /** Explicit lookup by declared type — the common case for a caller that already knows what kind of source it has (e.g. a frontend built from a discriminated `SourceInput.kind`). */
  resolve(sourceType: SourceType): SourceFrontend | undefined {
    return this.frontends.get(sourceType);
  }

  readonly sourceTypes = (): readonly SourceType[] => [...this.registrationOrder];

  /** Detection fallback for input that doesn't already declare its own type: probes every registered frontend's `canHandle`, in registration order, and returns the first match. Returns `undefined` (never throws) when nothing matches — callers that need an error should use `ingest`, which turns that into a `NOT_FOUND` `SourceError`. */
  detect(input: unknown): SourceFrontend | undefined {
    for (const sourceType of this.registrationOrder) {
      const frontend = this.frontends.get(sourceType)!;
      if (frontend.canHandle(input)) return frontend;
    }
    return undefined;
  }

  /** The one-call convenience path: detect + ingest, with a meaningful, stable error when no frontend matches (Stage 8 §5's "meaningful unsupported-source errors"). */
  ingest(input: unknown, context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const frontend = this.detect(input);
    if (!frontend) {
      return err(
        new SourceError(ErrorCode.NOT_FOUND, 'No registered source frontend can handle the given input', {
          context: { registeredTypes: this.sourceTypes() },
        }),
      );
    }
    return frontend.ingest(input, context);
  }
}
