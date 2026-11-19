import fs from "node:fs";
import path from "node:path";
import type { Category, Finding, ReviewResult } from "./types.js";

export interface ExpectedIssue {
  id: string;
  file: string;
  lines: [number, number];
  category: Category;
  acceptedCategories: Category[];
  expectedTool: "eslint" | "typescript" | "llm";
  explanation: string;
}
export interface Scenario {
  id: string;
  name: string;
  description: string;
  branch: string;
  files: string[];
  hasProblem: boolean;
  expectedTool: string | null;
  issues: ExpectedIssue[];
}
export interface GroundTruth {
  lineTolerance: number;
  scenarios: Scenario[];
}
export interface Adjudication {
  scenario: string;
  source: Finding["source"];
  file: string;
  line?: number;
  rule: string;
  verdict: "tp" | "fp" | "duplicate";
  issueId?: string;
  justification: string;
}

export type Verdict = "tp" | "fp" | "duplicate";
export interface JudgedFinding extends Finding {
  verdict: Verdict;
  issueId?: string;
  adjudicated?: boolean;
}
export interface ScenarioMetrics {
  scenario: string;
  mode: "static" | "hybrid";
  status: "ok" | "pending";
  tp: number;
  fp: number;
  fn: number;
  duplicates: number;
  precision: number | null;
  recall: number | null;
  timeMs: number | null;
  matchedIssues: string[];
  missedIssues: string[];
  findings: JudgedFinding[];
}

export const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);
export const fmtRatio = (v: number | null) => (v === null ? "N/A" : v.toFixed(3));

const sameFinding = (a: Adjudication, f: Finding) =>
  a.source === f.source && a.file === f.file && a.rule === f.rule && (a.line === undefined || a.line === f.line);

/**
 * Matches findings to the ground truth of one scenario. A finding is a TP when
 * it is in the same file, within the expected line range (± tolerance) and has
 * one of the accepted categories. Each expected issue counts at most once; further
 * findings matching an already-matched issue are counted as duplicates (neither TP
 * nor FP). Documented manual adjudications override automatic matching.
 * Static findings are matched before LLM findings.
 */
export function judge(
  scenario: Scenario,
  findings: Finding[],
  tolerance: number,
  adjudications: Adjudication[] = [],
): { findings: JudgedFinding[]; tp: number; fp: number; fn: number; duplicates: number; matched: Set<string> } {
  const matched = new Set<string>();
  const ordered = [...findings].sort((a, b) => Number(a.source === "llm") - Number(b.source === "llm"));
  const judged: JudgedFinding[] = [];
  for (const f of ordered) {
    const adj = adjudications.find((a) => a.scenario === scenario.id && sameFinding(a, f));
    if (adj) {
      let verdict = adj.verdict;
      if (verdict === "tp" && adj.issueId) {
        if (matched.has(adj.issueId)) verdict = "duplicate";
        else matched.add(adj.issueId);
      }
      judged.push({ ...f, verdict, issueId: adj.issueId, adjudicated: true });
      continue;
    }
    const candidates = scenario.issues.filter(
      (i) =>
        i.file === f.file &&
        f.line !== undefined &&
        f.line >= i.lines[0] - tolerance &&
        f.line <= i.lines[1] + tolerance &&
        i.acceptedCategories.includes(f.category),
    );
    const free = candidates.find((i) => !matched.has(i.id));
    if (free) {
      matched.add(free.id);
      judged.push({ ...f, verdict: "tp", issueId: free.id });
    } else if (candidates.length) {
      judged.push({ ...f, verdict: "duplicate", issueId: candidates[0].id });
    } else {
      judged.push({ ...f, verdict: "fp" });
    }
  }
  const tp = judged.filter((j) => j.verdict === "tp").length;
  const fp = judged.filter((j) => j.verdict === "fp").length;
  const duplicates = judged.filter((j) => j.verdict === "duplicate").length;
  return { findings: judged, tp, fp, fn: scenario.issues.length - matched.size, duplicates, matched };
}

/** A hybrid run is valid only if the LLM actually answered (no fabricated results). */
export const llmRan = (r: ReviewResult) => r.mode === "hybrid" && r.llmErrors.length < r.llmAttempts;

export function scenarioMetrics(
  scenario: Scenario,
  r: ReviewResult | undefined,
  mode: "static" | "hybrid",
  tolerance: number,
  adjudications: Adjudication[],
): ScenarioMetrics {
  const pending = !r || (mode === "hybrid" && !llmRan(r));
  if (pending) {
    return {
      scenario: scenario.id, mode, status: "pending", tp: 0, fp: 0, fn: 0, duplicates: 0,
      precision: null, recall: null, timeMs: null, matchedIssues: [], missedIssues: scenario.issues.map((i) => i.id), findings: [],
    };
  }
  const findings = mode === "static" ? r.static : r.hybrid;
  const j = judge(scenario, findings, tolerance, adjudications);
  return {
    scenario: scenario.id,
    mode,
    status: "ok",
    tp: j.tp,
    fp: j.fp,
    fn: j.fn,
    duplicates: j.duplicates,
    precision: ratio(j.tp, j.tp + j.fp),
    recall: ratio(j.tp, j.tp + j.fn),
    timeMs: mode === "static" ? r.staticMs : r.staticMs + r.llmMs,
    matchedIssues: [...j.matched],
    missedIssues: scenario.issues.filter((i) => !j.matched.has(i.id)).map((i) => i.id),
    findings: j.findings,
  };
}

export function aggregate(rows: ScenarioMetrics[]) {
  const ok = rows.filter((r) => r.status === "ok");
  const sum = (k: "tp" | "fp" | "fn" | "duplicates") => ok.reduce((a, r) => a + r[k], 0);
  const tp = sum("tp"), fp = sum("fp"), fn = sum("fn");
  const totalMs = ok.reduce((a, r) => a + (r.timeMs ?? 0), 0);
  return {
    scenariosEvaluated: ok.length,
    scenariosPending: rows.length - ok.length,
    tp, fp, fn,
    duplicates: sum("duplicates"),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    totalMs,
    meanMs: ok.length ? Math.round(totalMs / ok.length) : null,
  };
}

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;

/** Reads raw review results, computes metrics and writes static.json, hybrid.json, comparison.csv and summary.md. */
export function runEvaluation(opts: { groundTruth: string; rawDir: string; outDir: string; adjudication?: string; notes?: string }) {
  const gt = readJson<GroundTruth>(opts.groundTruth);
  const adjudications = opts.adjudication && fs.existsSync(opts.adjudication) ? readJson<Adjudication[]>(opts.adjudication) : [];
  const raw = new Map<string, ReviewResult>();
  for (const s of gt.scenarios) {
    const p = path.join(opts.rawDir, `${s.id}.json`);
    if (fs.existsSync(p)) raw.set(s.id, readJson<ReviewResult>(p));
  }
  const rows = { static: [] as ScenarioMetrics[], hybrid: [] as ScenarioMetrics[] };
  for (const s of gt.scenarios) {
    for (const mode of ["static", "hybrid"] as const) {
      rows[mode].push(scenarioMetrics(s, raw.get(s.id), mode, gt.lineTolerance, adjudications));
    }
  }
  const results = [...raw.values()];
  const llmResults = results.filter(llmRan);
  const extra = {
    findingsByTool: {
      eslint: results.reduce((a, r) => a + r.static.filter((f) => f.source === "eslint").length, 0),
      typescript: results.reduce((a, r) => a + r.static.filter((f) => f.source === "typescript").length, 0),
      llm: llmResults.reduce((a, r) => a + r.llm.length, 0),
    },
    llmDuplicatesRemoved: results.reduce((a, r) => a + r.llmDuplicates.length, 0),
    llmRejectedByValidation: results.reduce((a, r) => a + r.llmRejected.length, 0),
    llmApiErrors: results.flatMap((r) => r.llmErrors.map((e) => `${r.scenario}: ${e}`)),
    models: [...new Set(results.map((r) => r.model).filter(Boolean))],
    tokens: llmResults.reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0),
    llmOnlyIssues: rows.hybrid.flatMap((h, i) => {
      const st = rows.static[i];
      return h.status === "ok" ? h.matchedIssues.filter((id) => !st.matchedIssues.includes(id)) : [];
    }),
  };
  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const mode of ["static", "hybrid"] as const) {
    fs.writeFileSync(
      path.join(opts.outDir, `${mode}.json`),
      JSON.stringify({ mode, aggregate: aggregate(rows[mode]), scenarios: rows[mode] }, null, 2) + "\n",
    );
  }
  const csv = ["scenario,mode,status,tp,fp,fn,duplicates,precision,recall,time_ms"];
  for (const s of gt.scenarios) {
    for (const mode of ["static", "hybrid"] as const) {
      const m = rows[mode].find((r) => r.scenario === s.id)!;
      csv.push([s.id, mode, m.status, m.tp, m.fp, m.fn, m.duplicates, fmtRatio(m.precision), fmtRatio(m.recall), m.timeMs ?? "N/A"].join(","));
    }
  }
  fs.writeFileSync(path.join(opts.outDir, "comparison.csv"), csv.join("\n") + "\n");
  const notes = opts.notes && fs.existsSync(opts.notes) ? fs.readFileSync(opts.notes, "utf8") : "";
  fs.writeFileSync(path.join(opts.outDir, "summary.md"), renderSummary(gt, rows, extra, raw, notes));
  return { rows, extra };
}

function renderSummary(
  gt: GroundTruth,
  rows: { static: ScenarioMetrics[]; hybrid: ScenarioMetrics[] },
  extra: Record<string, any>,
  raw: Map<string, ReviewResult>,
  notes: string,
): string {
  const a = { static: aggregate(rows.static), hybrid: aggregate(rows.hybrid) };
  const L: string[] = [
    "# AutoReviewer — experimental results",
    "",
    "_Generated by `pnpm evaluate` from `experiments/results/raw/*.json` and `experiments/ground-truth.json`. Do not edit by hand._",
    "",
    "## Aggregate comparison",
    "",
    "| Modality | Scenarios evaluated | TP | FP | FN | Duplicates | Precision | Recall | Total time (s) | Mean time / PR (s) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const mode of ["static", "hybrid"] as const) {
    const x = a[mode];
    L.push(`| ${mode} | ${x.scenariosEvaluated}/${rows[mode].length}${x.scenariosPending ? ` (${x.scenariosPending} pending)` : ""} | ${x.tp} | ${x.fp} | ${x.fn} | ${x.duplicates} | ${fmtRatio(x.precision)} | ${fmtRatio(x.recall)} | ${(x.totalMs / 1000).toFixed(1)} | ${x.meanMs === null ? "N/A" : (x.meanMs / 1000).toFixed(2)} |`);
  }
  L.push(
    "",
    "Precision = TP/(TP+FP), Recall = TP/(TP+FN), micro-averaged over evaluated scenarios. `N/A` = zero denominator.",
    "Static time = ESLint + tsc on head and merge base (needed for attribution). Hybrid time = static time + Gemini call(s).",
    "",
    "## Per scenario",
    "",
    "| Scenario | Expected | Static TP/FP/FN | Hybrid TP/FP/FN | Static P / R | Hybrid P / R |",
    "|---|---|---|---|---|---|",
  );
  for (const s of gt.scenarios) {
    const st = rows.static.find((r) => r.scenario === s.id)!;
    const hy = rows.hybrid.find((r) => r.scenario === s.id)!;
    const t = (m: ScenarioMetrics) => (m.status === "pending" ? "pending" : `${m.tp}/${m.fp}/${m.fn}`);
    const pr = (m: ScenarioMetrics) => (m.status === "pending" ? "pending" : `${fmtRatio(m.precision)} / ${fmtRatio(m.recall)}`);
    L.push(`| ${s.id} ${s.name} | ${s.hasProblem ? s.issues.map((i) => `${i.category} (${i.expectedTool})`).join(", ") : "none (control)"} | ${t(st)} | ${t(hy)} | ${pr(st)} | ${pr(hy)} |`);
  }
  L.push(
    "",
    "## Other measurements",
    "",
    `- Findings by tool (PR-attributable): ESLint ${extra.findingsByTool.eslint}, TypeScript ${extra.findingsByTool.typescript}, LLM ${extra.findingsByTool.llm} (after validation and deduplication)`,
    `- Issues found only by the LLM (hybrid TP not found by static): ${extra.llmOnlyIssues.length ? extra.llmOnlyIssues.join(", ") : "none"}`,
    `- LLM recommendations removed as duplicates of static findings: ${extra.llmDuplicatesRemoved}`,
    `- LLM recommendations rejected by validation: ${extra.llmRejectedByValidation}`,
    `- LLM/API errors: ${extra.llmApiErrors.length ? "" : "none"}`,
    ...extra.llmApiErrors.map((e: string) => `  - ${e}`),
    `- Model(s): ${extra.models.join(", ") || "—"}`,
    `- Tokens used (total): ${extra.tokens || "—"}`,
    "",
    "## Examples (automatically selected from real results)",
    "",
  );
  const all = (mode: "static" | "hybrid") => rows[mode].flatMap((r) => r.findings.map((f) => ({ ...f, scenario: r.scenario })));
  const ex1 = all("static").find((f) => f.verdict === "tp");
  const ex2 = all("hybrid").find((f) => f.source === "llm" && f.verdict === "tp" && extra.llmOnlyIssues.includes(f.issueId));
  const ex3 =
    all("hybrid").find((f) => f.source === "llm" && f.verdict === "fp") ??
    rows.hybrid.flatMap((r) => r.missedIssues.map((id) => ({ scenario: r.scenario, id }))).find((m) => m.id && gt.scenarios.find((s) => s.id === m.scenario)?.issues.find((i) => i.id === m.id)?.expectedTool === "llm");
  const show = (f: any) => `\`${f.file}:${f.line}\` (${f.scenario}, ${f.source} \`${f.rule}\`): ${f.message.split("\n")[0]}${f.suggestion ? `\n  > Suggestion: ${f.suggestion}` : ""}`;
  L.push(`1. **Detected by static analysis** — ${ex1 ? show(ex1) : "no static true positive available"}`);
  L.push(`2. **Missed by static analysis, found by the LLM** — ${ex2 ? show(ex2) : "no such case in the results"}`);
  if (ex3 && "verdict" in ex3) L.push(`3. **LLM false positive** — ${show(ex3)}`);
  else if (ex3) {
    const s = gt.scenarios.find((x) => x.id === ex3.scenario)!;
    const issue = s.issues.find((i) => i.id === ex3.id)!;
    L.push(`3. **LLM missed an expected maintainability issue** — ${ex3.scenario} (${issue.category}, \`${issue.file}:${issue.lines.join("-")}\`): ${issue.explanation}`);
  } else L.push("3. **LLM failure / false positive** — none observed in the evaluated runs");
  if (notes.trim()) L.push("", notes.trim());
  const pendingIds = rows.hybrid.filter((r) => r.status === "pending").map((r) => r.scenario);
  if (pendingIds.length) L.push("", `> ⚠️ Hybrid results pending for: ${pendingIds.join(", ")} (LLM not executed or failed). No values were simulated.`);
  void raw;
  return L.join("\n") + "\n";
}
