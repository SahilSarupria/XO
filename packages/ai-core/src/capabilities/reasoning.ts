/** Stage 7's target shape: extractReasoning(). Per the compiler spec: NOT a summary — decision logic, tradeoffs, expert heuristics, exception handling, confidence, failure modes, and alternative reasoning paths, represented as a graph. */

export interface ReasoningStep {
  readonly id: string;
  readonly premise: string;
  readonly conclusion: string;
  readonly confidence: number;
}

export interface Tradeoff {
  readonly description: string;
  readonly favors: string;
  readonly against: string;
}

export interface ExceptionCase {
  readonly condition: string;
  readonly deviation: string;
}

export interface AlternativePath {
  readonly description: string;
  readonly whenApplicable: string;
  readonly stepIds: readonly string[]; // references ReasoningStep.id for the steps that make up this alternative
}

export interface ReasoningExtractionInput {
  readonly focusQuestion?: string; // e.g. "how does the source decide whether a clause is enforceable?"
}

export interface ReasoningExtractionOutput {
  readonly steps: readonly ReasoningStep[];
  readonly tradeoffs: readonly Tradeoff[];
  readonly exceptions: readonly ExceptionCase[];
  readonly alternativePaths: readonly AlternativePath[];
  readonly failureModes: readonly string[];
}
