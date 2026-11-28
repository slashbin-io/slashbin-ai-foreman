// The reads the review intake makes on GitHub: open PR heads, a head's commit status, and the repo's active
// rulesets. All reads; the Foreman writes no status (the Tech Lead writes every state, `pending` included).

import type { RepoConfig } from "../config.js";
import type { HeadStatus, OpenPrHead } from "../code-host.js";
import type { Logger } from "../logger.js";
import { ghAsync } from "./gh.js";

/** Every open PR's number and full head SHA. Throws when the read fails: a failed read is never "no PRs". */
export async function listOpenPrHeads(config: RepoConfig, _logger: Logger): Promise<OpenPrHead[]> {
  const out = await ghAsync(["pr", "list", "--repo", config.githubRepo, "--state", "open", "--limit", "200", "--json", "number,headRefOid"], config.repoPath);
  const rows = JSON.parse(out || "[]") as Array<{ number?: number; headRefOid?: string }>;
  const heads: OpenPrHead[] = [];
  for (const r of rows) if (typeof r.number === "number" && /^[0-9a-f]{40}$/.test(r.headRefOid ?? "")) heads.push({ number: r.number, sha: r.headRefOid as string });
  return heads;
}

/** The newest status for `context` on `sha`; the list GitHub returns is newest first. */
export async function readHeadStatus(config: RepoConfig, sha: string, context: string, _logger: Logger): Promise<HeadStatus | null> {
  const out = await ghAsync(["api", `repos/${config.githubRepo}/commits/${sha}/statuses`], config.repoPath);
  const rows = JSON.parse(out || "[]") as Array<{ context?: string; state?: string; description?: string | null; updated_at?: string; created_at?: string }>;
  const hit = rows.find((r) => r.context === context);
  if (!hit) return null;
  return { state: hit.state ?? "", description: hit.description ?? "", updatedAt: hit.updated_at ?? hit.created_at ?? "" };
}

/** Whether an active ruleset on the repo requires the status check `context`. */
export async function requiresStatusCheck(config: RepoConfig, context: string, _logger: Logger): Promise<boolean> {
  const out = await ghAsync(["api", `repos/${config.githubRepo}/rules/branches/${config.baseBranch}`], config.repoPath);
  const rules = JSON.parse(out || "[]") as Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>;
  return rules.some((r) => r.type === "required_status_checks" && (r.parameters?.required_status_checks ?? []).some((c) => c.context === context));
}
