// The GitHub reads and writes behind `awaiting evidence` expiry (src/phases/evidence-expiry.ts).

import type { RepoConfig } from "../config.js";
import { ghAsync } from "./gh.js";
import { extractImplementedIssues, type PrCommit } from "./discovery.js";

/** The newest event time on an issue's timeline (ms); null when it has none. Throws on a failed read. */
export async function lastIssueActivity(config: RepoConfig, num: number): Promise<number | null> {
  const out = await ghAsync(["api", "--paginate", `repos/${config.githubRepo}/issues/${num}/timeline?per_page=100`,
    "--jq", ".[] | (.created_at // .submitted_at // .committer.date // empty)"], config.repoPath);
  const times = out.split("\n").map((l) => Date.parse(l.trim())).filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Say why on the issue, close it as completed when `close`, then take `label` off. The label comes off last, so a step
 * that fails leaves the card labelled and the next pass retries. False on any failure; never throws.
 */
export async function retireLabelledIssue(config: RepoConfig, num: number, label: string, comment: string, close: boolean): Promise<boolean> {
  const repo = config.githubRepo;
  try {
    await ghAsync(["issue", "comment", String(num), "--repo", repo, "--body", comment], config.repoPath);
    if (close) await ghAsync(["issue", "close", String(num), "--repo", repo, "--reason", "completed"], config.repoPath);
    await ghAsync(["issue", "edit", String(num), "--repo", repo, "--remove-label", label], config.repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest PR merged to the production branch that names issue `num` (any keyword: `Closes`, `Related to`, a `(#N)`
 * headline suffix). It searches GitHub for the issue number instead of listing the latest PRs, so an old merge is found.
 * A merge to develop only does not count: the work has not shipped. Null when there is none. Throws on a failed read.
 */
export async function findShippedPr(config: RepoConfig, num: number): Promise<number | null> {
  const out = await ghAsync(["pr", "list", "--repo", config.githubRepo, "--state", "merged", "--base", config.productionBranch,
    "--search", `${num} in:title,body`, "--json", "number,title,body,commits,mergedAt", "--limit", "100"], config.repoPath);
  const prs = JSON.parse(out || "[]") as { number: number; title?: string; body?: string; commits?: PrCommit[]; mergedAt?: string }[];
  const hits = prs
    .filter((pr) => pr.mergedAt && pr.number !== num
      && extractImplementedIssues({ title: pr.title ?? "", body: pr.body ?? "", commits: pr.commits ?? [] }).includes(num))
    .sort((a, b) => Date.parse(b.mergedAt ?? "") - Date.parse(a.mergedAt ?? ""));
  return hits[0]?.number ?? null;
}
