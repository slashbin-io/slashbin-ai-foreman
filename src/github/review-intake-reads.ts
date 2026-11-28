// The reads the review intake makes on GitHub: open PR heads, a head's commit status, and the repo's active
// rulesets. All reads; the Foreman writes no status (the Tech Lead writes every state, `pending` included).

import type { RepoConfig } from "../config.js";
import type { HeadStatus, OpenPrHead } from "../code-host.js";
import type { Logger } from "../logger.js";
import { ghAsync } from "./gh.js";

/** Every open PR's number and full head SHA, across every page. Throws when the read fails: a failed read is never "no PRs". */
export async function listOpenPrHeads(config: RepoConfig, _logger: Logger): Promise<OpenPrHead[]> {
  const out = await ghAsync(["api", "--paginate", `repos/${config.githubRepo}/pulls?state=open&per_page=100`, "--jq", ".[] | {number, sha: .head.sha} | @json"], config.repoPath);
  const heads: OpenPrHead[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { number?: number; sha?: string };
    if (typeof r.number === "number" && /^[0-9a-f]{40}$/.test(r.sha ?? "")) heads.push({ number: r.number, sha: r.sha as string });
  }
  return heads;
}

/** The newest status for `context` on `sha`, across every page (GitHub lists newest first, so the first match is it). */
export async function readHeadStatus(config: RepoConfig, sha: string, context: string, _logger: Logger): Promise<HeadStatus | null> {
  const out = await ghAsync(["api", "--paginate", `repos/${config.githubRepo}/commits/${sha}/statuses?per_page=100`, "--jq", `.[] | select(.context == ${JSON.stringify(context)}) | @json`], config.repoPath);
  const first = out.split("\n").find((l) => l.trim());
  if (!first) return null;
  const hit = JSON.parse(first) as { state?: string; description?: string | null; updated_at?: string; created_at?: string };
  return { state: hit.state ?? "", description: hit.description ?? "", updatedAt: hit.updated_at ?? hit.created_at ?? "" };
}

/** Whether an active ruleset on the repo requires the status check `context`. */
export async function requiresStatusCheck(config: RepoConfig, context: string, _logger: Logger): Promise<boolean> {
  const out = await ghAsync(["api", `repos/${config.githubRepo}/rules/branches/${config.baseBranch}`], config.repoPath);
  const rules = JSON.parse(out || "[]") as Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>;
  return rules.some((r) => r.type === "required_status_checks" && (r.parameters?.required_status_checks ?? []).some((c) => c.context === context));
}
