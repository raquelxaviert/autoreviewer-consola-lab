#!/usr/bin/env node
// Runs the AutoReviewer on every scenario branch (dry-run, no PR modification)
// and stores one raw result per scenario in experiments/results/raw/<id>.json.
// Both modalities are derived from the same run: `static` = ESLint + tsc,
// `hybrid` = static + Gemini on the very same head commit and diff.
//
// Usage: node scripts/run-experiment.mjs [--only pr01,pr05] [--diff-source git|github] [--static-only]
//   env: GEMINI_API_KEY, GEMINI_MODEL (hybrid);  GITHUB_TOKEN, GITHUB_REPOSITORY (diff-source github,
//        PR numbers read from experiments/prs.json)
// Then: pnpm --dir tools/autoreviewer evaluate
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const ONLY = (arg("--only", "") ?? "").split(",").filter(Boolean);
const DIFF_SOURCE = arg("--diff-source", "git");
const STATIC_ONLY = argv.includes("--static-only");
const LAB = path.join(ROOT, "experiments/work/lab");
const RAW_STATIC = path.join(ROOT, "experiments/work/static");
const RAW = path.join(ROOT, "experiments/results/raw");
const CLI = path.join(ROOT, "tools/autoreviewer/dist/src/index.js");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
const git = (args, cwd = ROOT) => run("git", args, { cwd }).trim();

const gt = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments/ground-truth.json"), "utf8"));
const prs = fs.existsSync(path.join(ROOT, "experiments/prs.json"))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "experiments/prs.json"), "utf8"))
  : {};

if (!fs.existsSync(CLI)) throw new Error("Build the tool first: pnpm --dir tools/autoreviewer build");
if (!fs.existsSync(LAB)) {
  git(["worktree", "add", "--detach", LAB, gt.baseBranch]);
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: LAB, shell: process.platform === "win32" });
}
fs.mkdirSync(RAW_STATIC, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

for (const s of gt.scenarios) {
  if (ONLY.length && !ONLY.includes(s.id)) continue;
  git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", s.branch], LAB);
  const staticFile = path.join(RAW_STATIC, `${s.id}.json`);
  process.stdout.write(run(process.execPath, [CLI, "collect", "--cwd", LAB, "--base", gt.baseBranch, "--out", staticFile]));
  const env = {
    ...process.env,
    AUTOREVIEWER_MODE: STATIC_ONLY ? "static" : "hybrid",
    DRY_RUN: "true",
    ...(DIFF_SOURCE === "github" ? { PR_NUMBER: String(prs[s.id] ?? "") } : { PR_NUMBER: "" }),
  };
  const out = path.join(RAW, `${s.id}.json`);
  const reviewArgs = [CLI, "review", "--static", staticFile, "--scenario", s.id, "--out", out, "--diff-source", DIFF_SOURCE, "--cwd", LAB];
  process.stdout.write(run(process.execPath, reviewArgs, { env }) + "\n");
}
