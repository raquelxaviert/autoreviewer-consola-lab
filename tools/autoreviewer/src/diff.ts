import { execFileSync } from "node:child_process";
import type { ChangedFile } from "./types.js";

export interface ParsedPatch {
  /** New-file line number -> content, for added ("+") lines. */
  added: Map<number, string>;
  /** New-file line numbers visible in the diff (added + context), i.e. valid for side RIGHT. */
  visible: Set<number>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified-diff patch (as returned by the GitHub "list PR files" API)
 * and maps every added/context line to its line number in the new file.
 * Patch positions are never used: GitHub review comments are created with
 * `line` + `side: "RIGHT"`, which refer to new-file line numbers.
 */
export function parsePatch(patch: string | undefined): ParsedPatch {
  const added = new Map<number, string>();
  const visible = new Set<number>();
  if (!patch) return { added, visible };
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      added.set(newLine, raw.slice(1));
      visible.add(newLine);
      newLine++;
    } else if (!raw.startsWith("-")) {
      // context line (removed lines exist only on the LEFT side)
      visible.add(newLine);
      newLine++;
    }
  }
  return { added, visible };
}

/** Review scope: TypeScript sources under src/, excluding declarations, removed files and generated code. */
export function isRelevantFile(f: ChangedFile): boolean {
  const name = f.filename;
  if (f.status === "removed") return false;
  if (!name.startsWith("src/")) return false;
  if (!/\.(ts|mts|cts)$/.test(name) || name.endsWith(".d.ts")) return false;
  if (/(^|\/)(node_modules|dist|lib|build|coverage)\//.test(name)) return false;
  return true;
}

/**
 * Renders a patch with explicit new-file line numbers ("   42 + code"), so the
 * LLM can reference the same line numbers used by GitHub review comments.
 */
export function annotatePatch(patch: string | undefined): string {
  if (!patch) return "(patch unavailable)";
  const out: string[] = [];
  let n = 0;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      n = Number(header[1]);
      out.push(raw);
    } else if (raw.startsWith("\\")) {
      continue;
    } else if (raw.startsWith("+")) {
      out.push(`${String(n++).padStart(5)} + ${raw.slice(1)}`);
    } else if (raw.startsWith("-")) {
      out.push(`      - ${raw.slice(1)}`);
    } else {
      out.push(`${String(n++).padStart(5)}   ${raw.slice(1)}`);
    }
  }
  return out.join("\n");
}

export interface DiffContext {
  text: string;
  chars: number;
  truncated: boolean;
}

/** Concatenates relevant (annotated) patches for the LLM, truncating at `limit` characters. */
export function buildDiffContext(files: ChangedFile[], limit = 16_000): DiffContext {
  let text = "";
  let truncated = false;
  for (const f of files) {
    const block = `### File: ${f.filename} (${f.status})\n${annotatePatch(f.patch)}\n\n`;
    if (text.length + block.length > limit) {
      text += block.slice(0, Math.max(0, limit - text.length));
      text += "\n[... DIFF TRUNCATED BY AUTOREVIEWER ...]\n";
      truncated = true;
      break;
    }
    text += block;
  }
  return { text, chars: text.length, truncated };
}

/**
 * Returns numbered excerpts of the head version of a file around the changed
 * hunks (±`margin` lines), giving the LLM the enclosing function without
 * sending the whole repository.
 */
export function snippetAroundChanges(content: string, patch: string | undefined, margin = 15): string {
  const lines = content.split(/\r?\n/);
  const ranges: [number, number][] = [];
  for (const raw of (patch ?? "").split("\n")) {
    const m = HUNK_HEADER.exec(raw);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push([Math.max(1, start - margin), Math.min(lines.length, start + len - 1 + margin)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged
    .map(([a, b]) =>
      lines
        .slice(a - 1, b)
        .map((l, i) => `${String(a + i).padStart(5)} | ${l}`)
        .join("\n"),
    )
    .join("\n  ...\n");
}

/**
 * Local equivalent of `pulls.listFiles`, built from `git diff` between the
 * merge base and the head commit. Used for dry runs without GitHub access.
 */
export function gitChangedFiles(cwd: string, base: string, head: string): ChangedFile[] {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, head).trim();
  const statusMap: Record<string, string> = { A: "added", M: "modified", D: "removed" };
  const files: ChangedFile[] = [];
  for (const line of git("diff", "--name-status", "--no-renames", mergeBase, head).split("\n")) {
    if (!line.trim()) continue;
    const [code, filename] = line.split("\t");
    const full = git("diff", "--unified=3", "--no-color", mergeBase, head, "--", filename);
    const at = full.indexOf("\n@@");
    files.push({
      filename,
      status: statusMap[code[0]] ?? "modified",
      patch: at === -1 ? undefined : full.slice(at + 1).replace(/\n$/, ""),
    });
  }
  return files;
}

/** Reads a file at a given commit (local mode). */
export function gitShow(cwd: string, ref: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}
