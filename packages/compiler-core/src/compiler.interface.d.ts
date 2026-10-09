import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { CompilationStageResult, ExperienceIR } from './ir.types.js';
export interface CompilerInput {
    readonly domain: string;
    readonly sourceDocuments: readonly {
        readonly path: string;
        readonly mimeType: string;
    }[];
}
export interface CompilationReport {
    readonly ir: ExperienceIR;
    readonly stages: readonly CompilationStageResult[];
}
/**
 * The Experience Compiler's public contract (Professional Knowledge ->
 * Experience IR, per the project's staged pipeline). Deliberately
 * interface-only: implementing `compile()` is explicit business logic
 * this module ("no compiler implementation") is not building.
 */
export interface Compiler {
    compile(input: CompilerInput): Promise<Result<CompilationReport, XoError>>;
}
//# sourceMappingURL=compiler.interface.d.ts.map