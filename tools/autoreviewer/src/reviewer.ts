import type { Finding, ReviewResult } from "./types.js";

export const SUMMARY_MARKER = "<!-- autoreviewer:summary -->";
export const MAX_INLINE = 8;

/**
 * Removes LLM findings that obviously repeat something already known:
 * - same file, line within ±1 and same category as a static finding
 *   (e.g. the LLM re-reporting a type error or lint violation);
 * - same file, line and category as an earlier LLM finding.
 */
export function dedupe(staticFs: Finding[], llmFs: Finding[]): { unique: Finding[]; duplicates: Finding[] } {
  const unique: Finding[] = [];
  const duplicates: Finding[] = [];
  const near = (a: Finding, b: Finding, tol: number) =>
    a.file === b.file && a.line !== undefined && b.line !== undefined && Math.abs(a.line - b.line) <= tol;
  for (const f of llmFs) {
    const dupStatic = staticFs.some((s) => near(s, f, 1) && s.category === f.category);
    const dupLlm = unique.some((u) => near(u, f, 0) && u.category === f.category);
    (dupStatic || dupLlm ? duplicates : unique).push(f);
  }
  return { unique, duplicates };
}

/** Stable key used to avoid re-posting the same inline comment on re-runs. */
export const findingKey = (f: Finding) => `${f.source}:${f.file}:${f.line}:${f.rule}`;

const SOURCE_LABEL = { eslint: "ESLint", typescript: "TypeScript", llm: "LLM (Gemini)" } as const;

export function formatInlineComment(f: Finding): string {
  const parts = [`**AutoReviewer · ${SOURCE_LABEL[f.source]}** · \`${f.rule}\` · ${f.category} · severity: ${f.severity}`, "", f.message];
  if (f.suggestion) parts.push("", `**Suggestion:** ${f.suggestion}`);
  if (f.replacement != null) parts.push("", "```suggestion", f.replacement, "```");
  parts.push("", `<!-- autoreviewer:inline ${findingKey(f)} -->`);
  return parts.join("\n");
}

/** Picks inline-eligible findings (on added lines), static first, capped at MAX_INLINE. */
export function selectInline(findings: Finding[]): { inline: Finding[]; overflow: Finding[] } {
  const eligible = findings.filter((f) => f.inDiff && f.line);
  const inline = eligible.slice(0, MAX_INLINE);
  const overflow = findings.filter((f) => !inline.includes(f));
  return { inline, overflow };
}

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function formatSummary(r: ReviewResult, notInline: Finding[]): string {
  const count = (s: string) => r.static.filter((f) => f.source === s).length;
  const lines = [
    SUMMARY_MARKER,
    "## 🤖 AutoReviewer summary",
    "",
    `Commit: \`${r.headSha.slice(0, 7)}\` · mode: **${r.mode}**`,
    "",
    "| Source | Findings |",
    "|---|---|",
    `| ESLint | ${count("eslint")} |`,
    `| TypeScript | ${count("typescript")} |`,
    `| LLM (new recommendations) | ${r.mode === "hybrid" ? r.llm.length : "not run (static mode)"} |`,
    "",
    `- Static analysis time: ${fmtMs(r.staticMs)}`,
    `- Additional LLM time: ${r.mode === "hybrid" ? fmtMs(r.llmMs) : "—"}`,
    `- Model: ${r.model ?? "—"}${r.usage?.totalTokens ? ` (${r.usage.totalTokens} tokens)` : ""}`,
    `- Files reviewed: ${r.files.map((f) => `\`${f}\``).join(", ") || "none"}`,
  ];
  const notes: string[] = [];
  if (r.diffTruncated) notes.push(`Diff truncated to ${r.diffChars} characters before sending to the LLM.`);
  if (r.llmDuplicates.length) notes.push(`${r.llmDuplicates.length} LLM recommendation(s) dropped as duplicates of static findings.`);
  if (r.llmRejected.length) notes.push(`${r.llmRejected.length} LLM recommendation(s) rejected by validation (${[...new Set(r.llmRejected.map((x) => x.reason))].join("; ")}).`);
  for (const e of r.llmErrors) notes.push(`LLM error: ${e}`);
  for (const e of r.published?.errors ?? []) notes.push(`Publishing error: ${e}`);
  if (notes.length) lines.push("", "### Failures and limitations", ...notes.map((n) => `- ${n}`));
  if (notInline.length) {
    lines.push("", "### Findings not posted inline", "", "| Source | Location | Rule | Message |", "|---|---|---|---|");
    for (const f of notInline) {
      lines.push(`| ${f.source} | \`${f.file}${f.line ? `:${f.line}` : ""}\` | ${f.rule} | ${esc(f.message).slice(0, 300)} |`);
    }
  }
  if (r.static.length + r.llm.length === 0) lines.push("", "No problems found. ✅");
  return lines.join("\n");
}

export function printReport(r: ReviewResult): string {
  const out = [`AutoReviewer — ${r.repo ?? "local"} ${r.pr ? `#${r.pr}` : ""} ${r.headSha.slice(0, 7)} (mode=${r.mode}, model=${r.model ?? "-"})`];
  for (const f of r.hybrid.length ? r.hybrid : r.static) {
    out.push(`  [${f.source}] ${f.file}:${f.line ?? "?"} ${f.rule} ${f.inDiff ? "" : "(not on added line) "}- ${f.message.split("\n")[0]}`);
  }
  out.push(`  static=${r.static.length} llm=${r.llm.length} dup=${r.llmDuplicates.length} rejected=${r.llmRejected.length} staticMs=${r.staticMs} llmMs=${r.llmMs}`);
  for (const e of r.llmErrors) out.push(`  LLM error: ${e}`);
  return out.join("\n");
}
