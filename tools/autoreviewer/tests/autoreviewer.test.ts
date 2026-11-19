import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotatePatch, buildDiffContext, isRelevantFile, parsePatch } from "../src/diff.js";
import { judge, ratio, scenarioMetrics, aggregate, type Scenario } from "../src/evaluate.js";
import { reviewWithLlm, validateLlmResponse } from "../src/llm.js";
import { dedupe, formatInlineComment, selectInline } from "../src/reviewer.js";
import { attributeFindings, parseEslint, parseTsc, validateRawStatic } from "../src/static-analysis.js";
import type { Finding } from "../src/types.js";

// Two hunks: lines 10-14 and 40-44 of the new file.
const PATCH = [
  "@@ -10,4 +10,5 @@ export function a() {",
  "   const x = 1;",
  "-  const y = 2;",
  "+  let y = 2;",
  "+  let z = 3;",
  "   return x;",
  " }",
  "@@ -39,4 +40,5 @@ export function b() {",
  "   if (ok) {",
  "+    log(1);",
  "     run();",
  "-  }",
  "+  } // end",
  "+  done();",
  "\\ No newline at end of file",
].join("\n");

describe("diff parsing", () => {
  it("maps added and context lines of multiple hunks to new-file line numbers", () => {
    const p = parsePatch(PATCH);
    assert.deepEqual([...p.added.keys()], [11, 12, 41, 43, 44]);
    assert.equal(p.added.get(11), "  let y = 2;");
    assert.equal(p.added.get(44), "  done();");
    assert.deepEqual([...p.visible].sort((a, b) => a - b), [10, 11, 12, 13, 14, 40, 41, 42, 43, 44]);
  });

  it("annotates patches with line numbers and truncates context", () => {
    const text = annotatePatch(PATCH);
    assert.match(text, /^\s+11 \+ {3}let y = 2;$/m);
    assert.match(text, /^\s+- {3}const y = 2;$/m);
    const ctx = buildDiffContext([{ filename: "src/a.ts", status: "modified", patch: PATCH }], 100);
    assert.equal(ctx.truncated, true);
    assert.match(ctx.text, /DIFF TRUNCATED/);
  });

  it("filters files outside the review scope", () => {
    assert.equal(isRelevantFile({ filename: "src/utils/format.ts", status: "modified" }), true);
    assert.equal(isRelevantFile({ filename: "src/types.d.ts", status: "modified" }), false);
    assert.equal(isRelevantFile({ filename: "pnpm-lock.yaml", status: "modified" }), false);
    assert.equal(isRelevantFile({ filename: "test/consola.test.ts", status: "modified" }), false);
    assert.equal(isRelevantFile({ filename: "src/old.ts", status: "removed" }), false);
  });
});

describe("static analysis conversion", () => {
  it("converts ESLint JSON output", () => {
    const eslintJson = [
      {
        filePath: "/repo/src/consola.ts",
        messages: [
          { ruleId: "prefer-const", severity: 2, message: "'x' is never reassigned. Use 'const' instead.", line: 12, column: 7 },
          { ruleId: null, severity: 2, message: "Parsing error: ';' expected.", line: 3, column: 1, fatal: true },
        ],
      },
      { filePath: "/repo/src/ok.ts", messages: [] },
      { bogus: true },
    ];
    const fs = parseEslint(eslintJson, "/repo");
    assert.equal(fs.length, 2);
    assert.deepEqual(fs[0], {
      source: "eslint", file: "src/consola.ts", line: 12, column: 7, rule: "prefer-const",
      category: "lint_violation", severity: "medium", message: "'x' is never reassigned. Use 'const' instead.",
    });
    assert.equal(fs[1].rule, "eslint-parse-error");
    assert.deepEqual(parseEslint("not an array", "/repo"), []);
  });

  it("converts tsc --pretty false diagnostics (including continuation lines)", () => {
    const out = [
      "src/utils/format.ts(1,26): error TS2307: Cannot find module 'printj' or its corresponding type declarations.",
      "src/consola.ts(120,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Additional detail line.",
      "garbage line",
    ].join("\n");
    const fs = parseTsc(out, "/repo");
    assert.equal(fs.length, 2);
    assert.equal(fs[1].file, "src/consola.ts");
    assert.equal(fs[1].line, 120);
    assert.equal(fs[1].rule, "TS2322");
    assert.equal(fs[1].category, "type_error");
    assert.match(fs[1].message, /Additional detail line/);
  });

  it("keeps only findings introduced by the PR and flags added lines", () => {
    const pre: Finding = { source: "typescript", file: "src/utils/format.ts", line: 1, rule: "TS2307", category: "type_error", severity: "high", message: "printj" };
    const shifted: Finding = { ...pre, line: 2 }; // same pre-existing error, moved by one line
    const fresh: Finding = { source: "eslint", file: "src/a.ts", line: 11, rule: "prefer-const", category: "lint_violation", severity: "medium", message: "use const" };
    const elsewhere: Finding = { ...fresh, line: 30 };
    const kept = attributeFindings([shifted, fresh, elsewhere], [pre], [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].inDiff, true);
    assert.equal(kept[1].inDiff, false); // goes to the summary, not inline
  });

  it("rejects malformed static artifacts", () => {
    assert.throws(() => validateRawStatic({ version: 1, headSha: "x" }));
    const run = { eslint: [], tsc: "", ms: 1 };
    const sha = "a".repeat(40);
    assert.doesNotThrow(() => validateRawStatic({ version: 1, headSha: sha, baseSha: sha, head: run, base: run }));
  });
});

describe("LLM response validation", () => {
  const patches = new Map([["src/a.ts", parsePatch(PATCH)]]);
  const issue = { file: "src/a.ts", line: 41, category: "complexity", severity: "medium", explanation: "Nested logic.", suggestion: "Extract a helper.", replacement: null };

  it("accepts valid issues and discards invalid ones with reasons", () => {
    const text = JSON.stringify({
      issues: [
        issue,
        { ...issue, file: "src/other.ts" },
        { ...issue, line: 10 }, // context line, not added
        { ...issue, category: "style" },
        { ...issue, explanation: "" },
        { ...issue, line: 12, replacement: "  const z = 3;" },
        { ...issue, line: 11, replacement: "a\nb" },
      ],
    });
    const r = validateLlmResponse(text, patches);
    assert.equal(r.issues.length, 3);
    assert.equal(r.rejected.length, 4);
    assert.equal(r.issues[0].source, "llm");
    assert.equal(r.issues[1].replacement, "  const z = 3;");
    assert.equal(r.issues[2].replacement, null); // multi-line replacement dropped
    assert.ok(r.rejected.some((x) => /not changed/.test(x.reason)));
    assert.ok(r.rejected.some((x) => /not an added line/.test(x.reason)));
  });

  it("limits the number of issues", () => {
    const text = JSON.stringify({ issues: Array.from({ length: 7 }, () => issue) });
    const r = validateLlmResponse(text, patches);
    assert.equal(r.issues.length, 5);
  });

  it("throws on invalid JSON so the caller can retry", () => {
    assert.throws(() => validateLlmResponse("not json", patches), /not valid JSON/);
    assert.throws(() => validateLlmResponse('{"foo":1}', patches), /issues/);
  });

  it("retries once on invalid output and never fabricates results (mocked API)", async () => {
    let calls = 0;
    const reply = (text: string) =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 10 } }), { status: 200 });
    const okFetch = (async () => (++calls === 1 ? reply("oops") : reply(JSON.stringify({ issues: [issue] })))) as typeof fetch;
    const ok = await reviewWithLlm({ apiKey: "k", model: "m", userPrompt: "p", patches: new Map([["src/a.ts", PATCH]]), fetchImpl: okFetch });
    assert.equal(ok.attempts, 2);
    assert.equal(ok.issues.length, 1);
    assert.equal(ok.usage?.totalTokens, 20);

    const badFetch = (async () => reply("still not json")) as typeof fetch;
    const bad = await reviewWithLlm({ apiKey: "k", model: "m", userPrompt: "p", patches: new Map([["src/a.ts", PATCH]]), fetchImpl: badFetch });
    assert.equal(bad.attempts, 2);
    assert.equal(bad.issues.length, 0);
    assert.equal(bad.errors.length, 2);

    const downFetch = (async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as typeof fetch;
    const down = await reviewWithLlm({ apiKey: "k", model: "m", userPrompt: "p", patches: new Map(), fetchImpl: downFetch, retryDelayMs: 1 });
    assert.equal(down.issues.length, 0);
    assert.match(down.errors[0], /HTTP 429/);
  });
});

describe("consolidation", () => {
  const s: Finding = { source: "typescript", file: "src/a.ts", line: 11, rule: "TS2322", category: "type_error", severity: "high", message: "bad type", inDiff: true };
  const l = (over: Partial<Finding>): Finding => ({ source: "llm", file: "src/a.ts", line: 11, rule: "x", category: "type_error", severity: "medium", message: "m", inDiff: true, ...over });

  it("removes LLM findings that repeat static findings or each other", () => {
    const { unique, duplicates } = dedupe([s], [l({ line: 12 }), l({ category: "naming" }), l({ category: "naming" }), l({ file: "src/b.ts" })]);
    assert.equal(duplicates.length, 2);
    assert.deepEqual(unique.map((u) => `${u.file}:${u.category}`), ["src/a.ts:naming", "src/b.ts:type_error"]);
  });

  it("formats GitHub suggestion blocks and caps inline comments", () => {
    const body = formatInlineComment(l({ category: "naming", replacement: "  const total = 1;", suggestion: "Rename." }));
    assert.match(body, /```suggestion\n {2}const total = 1;\n```/);
    assert.match(body, /autoreviewer:inline llm:src\/a.ts:11:x/);
    const many = Array.from({ length: 12 }, (_, i) => l({ line: i + 1 }));
    const { inline, overflow } = selectInline([...many, { ...s, inDiff: false }]);
    assert.equal(inline.length, 8);
    assert.equal(overflow.length, 5);
  });
});

describe("metrics", () => {
  const scenario: Scenario = {
    id: "pr05", name: "dup", description: "", branch: "b", files: ["src/a.ts"], hasProblem: true, expectedTool: "llm",
    issues: [
      { id: "pr05-1", file: "src/a.ts", lines: [20, 30], category: "duplication", acceptedCategories: ["duplication", "refactoring"], expectedTool: "llm", explanation: "" },
      { id: "pr05-2", file: "src/a.ts", lines: [50, 50], category: "naming", acceptedCategories: ["naming"], expectedTool: "llm", explanation: "" },
    ],
  };
  const f = (line: number, category: Finding["category"], source: Finding["source"] = "llm"): Finding => ({ source, file: "src/a.ts", line, rule: category, category, severity: "medium", message: "m" });

  it("computes TP/FP/FN with single credit per expected issue", () => {
    const j = judge(scenario, [f(25, "refactoring"), f(18, "duplication"), f(80, "complexity")], 3);
    assert.equal(j.tp, 1);
    assert.equal(j.duplicates, 1); // second comment on the same issue is not a second hit
    assert.equal(j.fp, 1);
    assert.equal(j.fn, 1);
  });

  it("applies documented manual adjudication", () => {
    const j = judge(scenario, [f(80, "cohesion")], 3, [
      { scenario: "pr05", source: "llm", file: "src/a.ts", line: 80, rule: "cohesion", verdict: "tp", issueId: "pr05-2", justification: "same problem" },
    ]);
    assert.equal(j.tp, 1);
    assert.equal(j.fn, 1);
  });

  it("uses N/A (null) when a ratio has no denominator and aggregates micro-averages", () => {
    assert.equal(ratio(0, 0), null);
    const control: Scenario = { ...scenario, id: "pr13", hasProblem: false, issues: [] };
    const result = { headSha: "h", baseSha: "b", mode: "hybrid" as const, files: [], diffChars: 0, diffTruncated: false, staticMs: 100, llmMs: 50, llmAttempts: 1, llmErrors: [], llmRejected: [], llmDuplicates: [], static: [], llm: [], hybrid: [] };
    const m = scenarioMetrics(control, result, "hybrid", 3, []);
    assert.equal(m.precision, null);
    assert.equal(m.recall, null);
    assert.equal(m.timeMs, 150);
    const pending = scenarioMetrics(control, { ...result, llmAttempts: 0, llmErrors: ["no key"] }, "hybrid", 3, []);
    assert.equal(pending.status, "pending");
    const agg = aggregate([m, pending, { ...m, tp: 3, fp: 1, fn: 1 }]);
    assert.equal(agg.scenariosEvaluated, 2);
    assert.equal(agg.precision, 0.75);
    assert.equal(agg.recall, 0.75);
  });
});
