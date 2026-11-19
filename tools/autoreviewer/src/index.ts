#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { buildDiffContext, gitChangedFiles, gitShow, isRelevantFile, snippetAroundChanges } from "./diff.js";
import { runEvaluation } from "./evaluate.js";
import { getFileAt, getPr, listPrFiles, parseRepo, publish } from "./github.js";
import { buildUserPrompt, resolveModel, reviewWithLlm } from "./llm.js";
import { dedupe, printReport } from "./reviewer.js";
import { collectStatic, staticFindings, validateRawStatic } from "./static-analysis.js";
import type { ChangedFile, ReviewResult } from "./types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIFF_LIMIT = 16_000;
const SNIPPET_LIMIT = 8_000;

const USAGE = `AutoReviewer
  collect  --cwd <repo> --base <ref> --out <file>      Run ESLint + tsc on HEAD and merge base (raw JSON)
  review   --static <file> [--out <file>] [--scenario <id>] [--diff-source github|git] [--cwd <repo>]
           env: GITHUB_REPOSITORY, PR_NUMBER, GITHUB_TOKEN, GEMINI_API_KEY, GEMINI_MODEL,
                AUTOREVIEWER_MODE=static|hybrid (default hybrid), DRY_RUN=true|false (default false)
  evaluate [--ground-truth f] [--raw dir] [--out dir] [--adjudication f] [--notes f]`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: rest,
    options: {
      cwd: { type: "string" },
      base: { type: "string" },
      out: { type: "string" },
      static: { type: "string" },
      scenario: { type: "string" },
      "diff-source": { type: "string" },
      "ground-truth": { type: "string" },
      raw: { type: "string" },
      adjudication: { type: "string" },
      notes: { type: "string" },
    },
  });
  if (command === "collect") {
    const raw = collectStatic(path.resolve(a.cwd ?? "."), a.base ?? "experiment-base");
    write(a.out ?? "static-raw.json", raw);
    console.log(`collected static analysis: head ${raw.headSha.slice(0, 7)} (${raw.head.ms} ms), base ${raw.baseSha.slice(0, 7)} (${raw.base.ms} ms)`);
  } else if (command === "review") {
    const result = await review(a);
    if (a.out) write(a.out, result);
    console.log(printReport(result));
    if (result.published?.errors.length) {
      for (const e of result.published.errors) console.error(`::error::${e}`);
      process.exitCode = 1;
    }
  } else if (command === "evaluate") {
    const exp = path.join(REPO_ROOT, "experiments");
    const { rows } = runEvaluation({
      groundTruth: a["ground-truth"] ?? path.join(exp, "ground-truth.json"),
      rawDir: a.raw ?? path.join(exp, "results/raw"),
      outDir: a.out ?? path.join(exp, "results"),
      adjudication: a.adjudication ?? path.join(exp, "adjudication.json"),
      notes: a.notes ?? path.join(exp, "notes.md"),
    });
    console.log(`evaluated ${rows.static.length} scenarios -> ${a.out ?? path.join(exp, "results")}`);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
}

async function review(a: Record<string, string | undefined>): Promise<ReviewResult> {
  const env = process.env;
  const mode = env.AUTOREVIEWER_MODE === "static" ? "static" : "hybrid";
  const dryRun = env.DRY_RUN === "true" || env.DRY_RUN === "1";
  const staticPath = a.static ?? "static-raw.json";
  // The artifact may come from a job that ran untrusted PR code: validate before use.
  const raw = validateRawStatic(JSON.parse(fs.readFileSync(staticPath, "utf8")));
  const prNumber = env.PR_NUMBER ? Number(env.PR_NUMBER) : undefined;
  const source = a["diff-source"] ?? (prNumber ? "github" : "git");
  const cwd = path.resolve(a.cwd ?? REPO_ROOT);

  let octokit: Octokit | undefined;
  let owner = "", repo = "";
  let allFiles: ChangedFile[];
  let readHead: (file: string) => Promise<string | undefined>;
  if (source === "github") {
    if (!env.GITHUB_REPOSITORY || !prNumber || !env.GITHUB_TOKEN) {
      throw new Error("github diff source requires GITHUB_REPOSITORY, PR_NUMBER and GITHUB_TOKEN");
    }
    ({ owner, repo } = parseRepo(env.GITHUB_REPOSITORY));
    octokit = new Octokit({ auth: env.GITHUB_TOKEN, userAgent: "autoreviewer" });
    const pr = await getPr(octokit, owner, repo, prNumber);
    if (pr.headRepo !== pr.baseRepo) throw new Error(`Refusing to review PR from fork ${pr.headRepo}`);
    if (pr.headSha !== raw.headSha) throw new Error(`Static artifact is for ${raw.headSha}, PR head is ${pr.headSha}`);
    allFiles = await listPrFiles(octokit, owner, repo, prNumber);
    readHead = (file) => getFileAt(octokit!, owner, repo, file, pr.headSha);
  } else {
    allFiles = gitChangedFiles(cwd, raw.baseSha, raw.headSha);
    readHead = async (file) => gitShow(cwd, raw.headSha, file);
  }
  const files = allFiles.filter(isRelevantFile);
  const stat = staticFindings(raw, files);
  const diff = buildDiffContext(files, DIFF_LIMIT);

  const result: ReviewResult = {
    scenario: a.scenario,
    repo: env.GITHUB_REPOSITORY,
    pr: prNumber,
    headSha: raw.headSha,
    baseSha: raw.baseSha,
    mode,
    files: files.map((f) => f.filename),
    diffChars: diff.chars,
    diffTruncated: diff.truncated,
    staticMs: raw.head.ms + raw.base.ms,
    llmMs: 0,
    llmAttempts: 0,
    llmErrors: [],
    llmRejected: [],
    llmDuplicates: [],
    static: stat,
    llm: [],
    hybrid: [...stat],
  };

  if (mode === "hybrid" && files.length) {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      result.llmErrors.push("GEMINI_API_KEY not set — LLM review skipped (static results kept)");
    } else {
      const t0 = performance.now();
      try {
        const requested = env.GEMINI_MODEL || "gemini-2.5-flash";
        result.model = await resolveModel(apiKey, requested);
        if (result.model !== requested) result.llmErrors.push(`model ${requested} unavailable; used ${result.model}`);
        let snippets = "";
        for (const f of files) {
          const content = await readHead(f.filename);
          if (content) snippets += `### ${f.filename}\n${snippetAroundChanges(content, f.patch)}\n\n`;
        }
        if (snippets.length > SNIPPET_LIMIT) snippets = snippets.slice(0, SNIPPET_LIMIT) + "\n[... excerpts truncated ...]";
        const llm = await reviewWithLlm({
          apiKey,
          model: result.model,
          userPrompt: buildUserPrompt(diff.text, snippets, stat, diff.truncated),
          patches: new Map(files.map((f) => [f.filename, f.patch])),
        });
        const { unique, duplicates } = dedupe(stat, llm.issues);
        Object.assign(result, {
          llmAttempts: llm.attempts,
          llmErrors: [...result.llmErrors, ...llm.errors],
          llmRejected: llm.rejected,
          llmDuplicates: duplicates,
          usage: llm.usage,
          llm: unique,
          hybrid: [...stat, ...unique],
        });
      } catch (error) {
        result.llmErrors.push((error as Error).message);
      }
      result.llmMs = Math.round(performance.now() - t0);
    }
  }

  if (!dryRun && octokit && prNumber) {
    result.published = await publish(octokit, owner, repo, prNumber, result);
  }
  return result;
}

function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

main().catch((error) => {
  console.error(`::error::AutoReviewer failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
