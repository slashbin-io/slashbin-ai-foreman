// The GitHub reads and writes behind `awaiting evidence` expiry (src/phases/evidence-expiry.ts).

import type { RepoConfig } from "../config.js";
import { ghAsync } from "./gh.js";
import { canonicalRepo } from "./repo-identity.js";

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
 * Merged base -> production promotions whose text mentions issue `num` (one search; the caller confirms each hit by its
 * manifest, since a search also matches an incidental mention). Throws on a failed read.
 */
export async function mergedPromotionsMentioning(config: RepoConfig, num: number): Promise<{ body: string }[]> {
  // `--search` on a pre-transfer name answers empty, not an error: use the canonical name.
  const repo = await canonicalRepo(config.githubRepo, config.repoPath);
  const out = await ghAsync([
    "pr", "list", "--repo", repo, "--state", "merged", "--base", config.productionBranch, "--head", config.baseBranch,
    "--search", `${num} in:body`, "--json", "body", "--limit", "100",
  ], config.repoPath);
  return JSON.parse(out || "[]") as { body: string }[];
}
