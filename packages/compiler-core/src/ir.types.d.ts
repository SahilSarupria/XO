import type { ComponentKind } from '@xo/types';
/**
 * The Experience IR: the intermediate representation the (unimplemented)
 * Experience Compiler produces from raw professional knowledge, and the
 * form an (unimplemented) packager turns into an XO's on-disk components.
 * This module defines the shape only — see EXPERIENCE_COMPILER.md for the
 * frozen design this must not deviate from. No compiler logic lives here.
 */
export interface ExperienceIR {
    readonly formatVersion: string;
    readonly domain: string;
    readonly sections: Readonly<Partial<Record<ComponentKind, unknown>>>;
}
export type CompilationStageName = 'ingest' | 'extract_knowledge' | 'build_reasoning' | 'derive_prompting' | 'validate' | 'emit_ir';
export interface CompilationStageResult {
    readonly stage: CompilationStageName;
    readonly durationMs: number;
    readonly warnings: readonly string[];
}
//# sourceMappingURL=ir.types.d.ts.map