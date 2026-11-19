import { Octokit } from "@octokit/rest";
import { findingKey, formatInlineComment, formatSummary, selectInline, SUMMARY_MARKER } from "./reviewer.js";
import type { ChangedFile, Finding, ReviewResult } from "./types.js";

export function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository '${full}' (expected owner/name)`);
  return { owner, repo };
}

export interface PrInfo {
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRepo: string;
  baseRepo: string;
}

export async function getPr(octokit: Octokit, owner: string, repo: string, pull_number: number): Promise<PrInfo> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    headSha: data.head.sha,
    baseSha: data.base.sha,
    baseRef: data.base.ref,
    headRepo: data.head.repo?.full_name ?? "",
    baseRepo: data.base.repo.full_name,
  };
}

/** All changed files of a PR (paginated; the API returns up to 3000 files). */
export async function listPrFiles(octokit: Octokit, owner: string, repo: string, pull_number: number): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
  return files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
}

export async function getFileAt(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data) && data.type === "file" && "content" in data) return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    /* file may not exist at that ref; context excerpts are optional */
  }
  return undefined;
}

/**
 * Publishes inline review comments (side RIGHT, new-file line numbers) and an
 * upserted summary comment. Comments already posted by a previous run (same
 * hidden key on the same commit) are not posted again.
 */
export async function publish(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  result: ReviewResult,
): Promise<NonNullable<ReviewResult["published"]>> {
  const errors: string[] = [];
  const findings: Finding[] = result.mode === "hybrid" ? result.hybrid : result.static;
  const { inline, overflow } = selectInline(findings);

  const existing = await octokit.paginate(octokit.pulls.listReviewComments, { owner, repo, pull_number, per_page: 100 });
  const postedKeys = new Set(
    existing
      .filter((c) => c.commit_id === result.headSha || c.original_commit_id === result.headSha)
      .map((c) => /<!-- autoreviewer:inline (.+?) -->/.exec(c.body)?.[1])
      .filter(Boolean),
  );
  const toPost = inline.filter((f) => !postedKeys.has(findingKey(f)));
  let posted = 0;
  if (toPost.length) {
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id: result.headSha,
        event: "COMMENT",
        body: `AutoReviewer: ${toPost.length} inline comment(s) for \`${result.headSha.slice(0, 7)}\`.`,
        comments: toPost.map((f) => ({ path: f.file, line: f.line!, side: "RIGHT" as const, body: formatInlineComment(f) })),
      });
      posted = toPost.length;
    } catch (error) {
      errors.push(describeError("create review with inline comments", error));
    }
  }

  const notInline = errors.length ? findings : overflow;
  const pub = { inline: posted, skippedExisting: inline.length - toPost.length, errors };
  const body = formatSummary({ ...result, published: pub }, notInline);
  try {
    const comments = await octokit.paginate(octokit.issues.listComments, { owner, repo, issue_number: pull_number, per_page: 100 });
    const mine = comments.find((c) => c.body?.includes(SUMMARY_MARKER));
    const res = mine
      ? await octokit.issues.updateComment({ owner, repo, comment_id: mine.id, body })
      : await octokit.issues.createComment({ owner, repo, issue_number: pull_number, body });
    return { ...pub, summaryUrl: res.data.html_url };
  } catch (error) {
    errors.push(describeError("publish summary comment", error));
    return pub;
  }
}

function describeError(action: string, error: unknown): string {
  const e = error as { status?: number; message?: string };
  const hint = e.status === 403 || e.status === 404 ? " — check that the token has 'pull-requests: write' permission" : "";
  return `Failed to ${action} (HTTP ${e.status ?? "?"}): ${e.message ?? String(error)}${hint}`;
}
