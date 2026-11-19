export const CATEGORIES = [
  "type_error",
  "lint_violation",
  "duplication",
  "complexity",
  "naming",
  "cohesion",
  "coupling",
  "error_handling",
  "refactoring",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Source = "eslint" | "typescript" | "llm";

/** Unified finding produced by any of the three sources. */
export interface Finding {
  source: Source;
  file: string; // repo-relative, forward slashes (e.g. "src/consola.ts")
  line?: number;
  column?: number;
  rule: string; // ESLint rule id, "TS2322", or the LLM category
  category: Category;
  severity: Severity;
  message: string;
  suggestion?: string;
  replacement?: string | null; // single-line replacement for a GitHub suggestion block
  /** true when `line` is an added line of the PR diff (eligible for an inline comment). */
  inDiff?: boolean;
}

/** Shape of a PR file as returned by `pulls.listFiles` (subset). */
export interface ChangedFile {
  filename: string;
  status: string; // added | modified | removed | renamed | ...
  patch?: string;
}

/** Raw static-analysis output exported by job 1 (untrusted data in job 2). */
export interface RawStaticRun {
  eslint: unknown; // ESLint JSON formatter output
  tsc: string; // tsc --pretty false output
  ms: number;
}
export interface RawStatic {
  version: 1;
  headSha: string;
  baseSha: string;
  head: RawStaticRun;
  base: RawStaticRun;
}

export interface LlmUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Output of a single review run (one PR, both modalities computed from the same inputs). */
export interface ReviewResult {
  scenario?: string;
  repo?: string;
  pr?: number;
  headSha: string;
  baseSha: string;
  mode: "static" | "hybrid";
  model?: string;
  files: string[];
  diffChars: number;
  diffTruncated: boolean;
  staticMs: number;
  llmMs: number;
  llmAttempts: number;
  llmErrors: string[];
  llmRejected: { issue: unknown; reason: string }[];
  llmDuplicates: Finding[];
  usage?: LlmUsage;
  static: Finding[];
  llm: Finding[];
  hybrid: Finding[];
  published?: { inline: number; skippedExisting: number; summaryUrl?: string; errors: string[] };
}
