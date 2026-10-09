import type { JsonSchema } from './json-schema.js';
import type { CapabilityId } from './capability-types.js';
/** Maps each capability to the JSON Schema its output must conform to — the single source of truth `router.ts` validates against and provider adapters request structured output against. */
export declare const CAPABILITY_OUTPUT_SCHEMAS: Readonly<Record<CapabilityId, JsonSchema>>;
//# sourceMappingURL=capability-schemas.d.ts.map