import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parsePatch } from "./diff.js";
import type { ChangedFile, Finding, RawStatic, RawStaticRun } from "./types.js";

const MAX_FINDINGS = 2000;
const MAX_MSG = 1000;

function toRepoPath(file: string, cwd: string): string {
  const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

const clip = (s: string) => (s.length > MAX_MSG ? s.slice(0, MAX_MSG) + "…" : s);
const safeRepoPath = (p: string) => /^[\w@.\-/]+$/.test(p) && !p.includes("..");

/**
 * Converts ESLint `--format json` output into unified findings.
 * Input is treated as untrusted (it may come from a CI artifact): malformed
 * entries are skipped instead of throwing.
 */
export function parseEslint(json: unknown, cwd: string): Finding[] {
  const out: Finding[] = [];
  if (!Array.isArray(json)) return out;
  for (const fileResult of json) {
    if (!fileResult || typeof fileResult.filePath !== "string" || !Array.isArray(fileResult.messages)) continue;
    const file = toRepoPath(fileResult.filePath, cwd);
    if (!safeRepoPath(file)) continue;
    for (const m of fileResult.messages) {
      if (!m || typeof m.message !== "string") continue;
      if (out.length >= MAX_FINDINGS) return out;
      out.push({
        source: "eslint",
        file,
        line: Number.isInteger(m.line) ? m.line : undefined,
        column: Number.isInteger(m.column) ? m.column : undefined,
        rule: typeof m.ruleId === "string" ? m.ruleId : "eslint-parse-error",
        category: "lint_violation",
        severity: m.severity === 2 ? "medium" : "low",
        message: clip(m.message),
      });
    }
  }
  return out;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

/** Converts `tsc --pretty false` text output into unified findings (continuation lines are appended). */
export function parseTsc(text: string, cwd: string): Finding[] {
  const out: Finding[] = [];
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    const m = TSC_LINE.exec(line);
    if (m) {
      if (out.length >= MAX_FINDINGS) break;
      const file = toRepoPath(m[1], cwd);
      if (!safeRepoPath(file)) continue;
      out.push({
        source: "typescript",
        file,
        line: Number(m[2]),
        column: Number(m[3]),
        rule: m[5],
        category: "type_error",
        severity: m[4] === "error" ? "high" : "medium",
        message: clip(m[6]),
      });
    } else if (line.startsWith("  ") && out.length > 0) {
      const last = out.at(-1)!;
      last.message = clip(`${last.message}\n${line.trim()}`);
    }
  }
  return out;
}

/**
 * Runs ESLint and tsc on the checkout in `cwd`. Non-zero exit codes are
 * expected (they signal findings); only the structured output matters.
 */
export function runStatic(cwd: string): RawStaticRun {
  const t0 = performance.now();
  const node = process.execPath;
  const eslint = spawnSync(node, [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "src", "--format", "json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let eslintJson: unknown = [];
  try {
    // Store repo-relative paths so the artifact does not depend on the runner's directory.
    eslintJson = (JSON.parse(eslint.stdout || "[]") as { filePath: string }[]).map((r) => ({
      ...r,
      filePath: toRepoPath(r.filePath, cwd),
    }));
  } catch {
    throw new Error(`ESLint did not produce JSON (exit ${eslint.status}): ${eslint.stderr?.slice(0, 500)}`);
  }
  const tsc = spawnSync(
    node,
    [path.join(cwd, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit", "--pretty", "false"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { eslint: eslintJson, tsc: tsc.stdout ?? "", ms: Math.round(performance.now() - t0) };
}

/**
 * Runs static analysis on the head commit and on the merge base, so that
 * diagnostics that already existed before the PR can be discounted.
 * Requires a clean tracked working tree (it temporarily checks out the base).
 */
export function collectStatic(cwd: string, baseRef: string): RawStatic {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("collect requires a clean working tree (tracked files modified)");
  }
  const headSha = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const baseSha = git("merge-base", baseRef, headSha);
  const head = runStatic(cwd);
  let base: RawStaticRun;
  try {
    git("-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", baseSha);
    base = runStatic(cwd);
  } finally {
    git("checkout", "--quiet", branch === "HEAD" ? headSha : branch);
  }
  return { version: 1, headSha, baseSha, head, base };
}

/** Validates the shape of a RawStatic object read from an (untrusted) artifact. */
export function validateRawStatic(data: unknown): RawStatic {
  const d = data as RawStatic;
  const okRun = (r: RawStaticRun | undefined) =>
    !!r && Array.isArray(r.eslint) && typeof r.tsc === "string" && typeof r.ms === "number" && r.tsc.length < 5_000_000;
  const sha = /^[0-9a-f]{40}$/;
  if (!d || d.version !== 1 || !sha.test(d.headSha) || !sha.test(d.baseSha) || !okRun(d.head) || !okRun(d.base)) {
    throw new Error("Invalid static-analysis artifact");
  }
  return d;
}

const fingerprint = (f: Finding) => `${f.source}|${f.file}|${f.rule}|${f.message}`;

/**
 * Keeps only diagnostics introduced by the PR: head findings (under src/)
 * whose fingerprint (source, file, rule, message — line-independent, so it
 * survives line shifts) occurs more often in head than in base.
 * Each kept finding is flagged `inDiff` when it points at an added line.
 */
export function attributeFindings(head: Finding[], base: Finding[], files: ChangedFile[]): Finding[] {
  const baseCounts = new Map<string, number>();
  for (const f of base) baseCounts.set(fingerprint(f), (baseCounts.get(fingerprint(f)) ?? 0) + 1);
  const patches = new Map(files.map((f) => [f.filename, parsePatch(f.patch)]));
  const result: Finding[] = [];
  for (const f of head) {
    if (!f.file.startsWith("src/")) continue;
    const key = fingerprint(f);
    const remaining = baseCounts.get(key) ?? 0;
    if (remaining > 0) {
      baseCounts.set(key, remaining - 1);
      continue;
    }
    const added = patches.get(f.file)?.added;
    result.push({ ...f, inDiff: !!(added && f.line && added.has(f.line)) });
  }
  return result;
}

/** Normalizes a RawStatic artifact into PR-attributable findings. */
export function staticFindings(raw: RawStatic, files: ChangedFile[], cwd = process.cwd()): Finding[] {
  const head = [...parseEslint(raw.head.eslint, cwd), ...parseTsc(raw.head.tsc, cwd)];
  const base = [...parseEslint(raw.base.eslint, cwd), ...parseTsc(raw.base.tsc, cwd)];
  return attributeFindings(head, base, files);
}
