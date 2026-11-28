// Branch state: the post-implement self-check, remote heads, and branch-drift sync PRs.

import type { Logger } from "../logger.js";
import { findOpenPrs, formatGhError } from "./cache.js";
import { ghAsync, ghAsTechLeadAsync, ghHttpStatus, isBackoffRefusal } from "./gh.js";
import { DEFAULT_GITHUB_CONVENTIONS, fillTitle, signed, type GithubConventions } from "./conventions.js";
import { OpenPromotionPR } from "./promotion.js";
import type { BranchDrift } from "../code-host.js";
export type { BranchDrift } from "../code-host.js";


// --- Post-Implementation Self-Check ---

/**
 * After a PR is created, verify it has actual file changes.
 * Returns the count of changed files, or -1 when there is no open PR. A failed
 * read throws (EM#1244 f5): it is never "no PR".
 * Logs the changed files for traceability (Second Way).
 */
export async function checkPRHasChanges(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): Promise<number> {
  const json = await ghAsync([
    "pr", "list",
    "--repo", repo,
    "--head", headBranch,
    "--base", baseBranch,
    "--state", "open",
    "--json", "number,files",
    "--limit", "1",
  ], cwd);

  const prs = JSON.parse(json || "[]");
  if (prs.length === 0) return -1;

  const files: { path: string }[] = prs[0].files || [];
  if (files.length === 0) {
    logger.warn("PR has no file changes — implementation may have failed silently");
    return 0;
  }

  logger.info(`PR #${prs[0].number} modifies ${files.length} file(s): ${files.map((f: { path: string }) => f.path).join(", ")}`);
  return files.length;
}

/**
 * Read the current HEAD SHA of a remote branch via the GitHub API. A failed
 * read throws (EM#1244 f5): a transient gh error is never a real "branch
 * unchanged" signal. Null only when the branch does not exist (a 404).
 */
export async function getRemoteBranchSha(
  repo: string,
  branch: string,
  cwd: string,
  logger: Logger,
): Promise<string | null> {
  let out: string;
  try {
    // --include puts the HTTP status line ahead of the body, on a failure too, so absence is read from the
    // response's own status and never from text that can carry the branch name (a branch "fix-404").
    out = await ghAsync([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}`,
      "--include",
      "--jq", ".commit.sha",
    ], cwd);
  } catch (err) {
    if (ghHttpStatus(err) === 404) return null;
    throw err;
  }
  const sha = out.split("\n").pop()?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}@${branch}: GitHub returned no head sha`);
  return sha;
}

/** GitHub's compare API lists at most this many files; a list this long may be truncated. */
export const COMPARE_FILE_CAP = 300;

/**
 * A path whose change has no production effect: agent tooling under `.claude/`
 * (the skill syncs, chore commits). It rides the next real release and never
 * makes `develop` worth promoting on its own (shipping_app, 2026-10-15:
 * develop ahead by two SKILL.md files, WARNed as a stalled promotion hourly).
 */
export function isNonProductionPath(path: string): boolean {
  return path.startsWith(".claude/");
}

/**
 * How many of the drift's changed files can change production: every file
 * outside `.claude/`. Unknown counts as production: without the path list, or
 * when it may be truncated, the full file count is returned.
 */
export function productionDriftFiles(drift: BranchDrift): number {
  const paths = drift.developAheadPaths;
  if (!paths || paths.length !== drift.developAheadFiles || paths.length >= COMPARE_FILE_CAP) return drift.developAheadFiles;
  return paths.filter((p) => !isNonProductionPath(p)).length;
}

let driftGate: ((repo: string, branches: readonly string[]) => Promise<boolean>) | null = null;
const lastDrift = new Map<string, BranchDrift>();

/**
 * Install the branch-move gate (daemon wiring). A drift result is a function of the two branch heads
 * alone, so while neither moved the last one is still the answer: ~12 pushes/hr to a production or base
 * branch fleet-wide against ~450 webhook events/hr. Null clears it: every check reads.
 */
export function configureDriftGate(due: ((repo: string, branches: readonly string[]) => Promise<boolean>) | null): void {
  driftGate = due;
  lastDrift.clear();
}

/**
 * Check if develop has drifted behind main due to accumulated merge commits.
 * Returns the drift counts, or null if the check fails.
 */
export async function checkBranchDrift(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): Promise<BranchDrift | null> {
  const key = `${repo}\u0000${productionBranch}...${baseBranch}`;
  const last = lastDrift.get(key);
  if (driftGate && last && !(await driftGate(repo, [productionBranch, baseBranch]).catch(() => true))) return last;
  try {
    const json = await ghAsync([
      "api", `repos/${repo}/compare/${productionBranch}...${baseBranch}`,
      "--jq", '{"ahead": .ahead_by, "behind": .behind_by, "files": ((.files // []) | length), "paths": [(.files // [])[].filename]}',
    ], cwd);

    const result = JSON.parse(json);
    const drift: BranchDrift = {
      developAheadOfMain: result.ahead,
      developBehindMain: result.behind,
      // Changed files between main and develop. `ahead > 0 && files === 0` is the
      // NORMAL steady state, not a stall: the main -> develop sync PR leaves a
      // merge commit on develop that main does not have, carrying no file change.
      // Counting commits alone flags every repo, forever. GitHub truncates this
      // array on very large diffs but never empties it, so 0 really means 0.
      developAheadFiles: result.files ?? 0,
      ...(Array.isArray(result.paths) ? { developAheadPaths: result.paths.filter((p: unknown): p is string => typeof p === "string") } : {}),
    };
    if (driftGate) lastDrift.set(key, drift);
    return drift;
  } catch (err) {
    // The gate counted the move as seen: drop the stale answer so the next pass reads again.
    lastDrift.delete(key);
    if (isBackoffRefusal(err)) {
      logger.debug("Failed to check branch drift — GitHub back-off active");
      return null;
    }
    logger.error("Failed to check branch drift", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a sync PR (main → develop) already exists. Null only when there is none: a failed
 * read throws (EM#1244 f5), because "could not look" must never open a second sync PR.
 */
export async function findOpenSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): Promise<OpenPromotionPR | null> {
  // The sync branch first; a PR opened by an older Foreman with the production branch itself as head is still found.
  for (const head of [syncBranchName(productionBranch, baseBranch), productionBranch]) {
    const prs: OpenPromotionPR[] = await findOpenPrs(repo, cwd, { base: baseBranch, head, limit: 1 });
    if (prs.length > 0) return prs[0];
  }
  return null;
}

/**
 * The branch a sync PR comes from. It is cut from the base and has the production branch merged in, so it
 * CONTAINS the base: a sync PR whose head was the production branch itself is BEHIND the moment the base
 * has any commit production lacks, which `strict` branch protection refuses for good, and updating it would
 * merge the base into production. This branch can be updated safely; production is never written.
 */
export function syncBranchName(productionBranch: string, baseBranch: string): string {
  return `foreman/sync-${productionBranch}-into-${baseBranch}`;
}

/** Cut the sync branch from the base's tip (moving a leftover one there) and merge production into it. */
async function prepareSyncBranch(repo: string, productionBranch: string, baseBranch: string, cwd: string): Promise<string> {
  const branch = syncBranchName(productionBranch, baseBranch);
  const sha = (await ghAsync(["api", `repos/${repo}/git/ref/heads/${baseBranch}`, "--jq", ".object.sha"], cwd)).trim();
  try {
    await ghAsync(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`], cwd);
  } catch {
    // A branch left by an earlier merged sync PR: move it to the base's tip.
    await ghAsync(["api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${branch}`, "-f", `sha=${sha}`, "-F", "force=true"], cwd);
  }
  await ghAsync(["api", "-X", "POST", `repos/${repo}/merges`, "-f", `base=${branch}`, "-f", `head=${productionBranch}`, "-f", `commit_message=Sync ${baseBranch} with ${productionBranch}`], cwd);
  return branch;
}

/**
 * Create a sync PR to merge main back into develop, then immediately
 * approve + merge it. Created and merged as slashbin-foreman (Foreman token),
 * approved as slasbhin-techlead to satisfy branch protection's "no
 * self-approval" rule.
 *
 * This eliminates the stale sync PR race condition where develop
 * advances between PR creation and external merge.
 */
export async function createSyncPR(
  repo: string,
  productionBranch: string,
  baseBranch: string,
  behindBy: number,
  cwd: string,
  logger?: Logger,
  conventions: GithubConventions = DEFAULT_GITHUB_CONVENTIONS,
): Promise<string | null> {
  try {
    const head = await prepareSyncBranch(repo, productionBranch, baseBranch, cwd);
    const result = await ghAsync([
      "pr", "create",
      "--repo", repo,
      "--base", baseBranch,
      "--head", head,
      "--title", fillTitle(conventions.syncTitle, { base: baseBranch, production: productionBranch }),
      "--body", signed(`## Branch Sync\n\nSync \`${baseBranch}\` with \`${productionBranch}\` to backfill ${behindBy} merge commit(s) from prior promotions. No code changes — only merge commit history alignment.`, conventions),
    ], cwd);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = match ? match[0] : null;

    if (!prUrl) return null;

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) return prUrl;

    const prNumber = prNumberMatch[1];

    // Immediately approve + merge, both as the Tech Lead. The merge is what
    // triggers the dev deploy, and Railway holds any deploy merged by a GitHub
    // account with no linked workspace member for manual approval. The Foreman
    // coordinates and has no Railway account (owner, 2026-10-10); merging as the
    // Foreman stalled every post-promotion dev deploy (inventory_service#410).
    try {
      await ghAsTechLeadAsync([
        "pr", "review", prNumber,
        "--repo", repo,
        "--approve",
        "--body", `Branch sync: head is \`${productionBranch}\`, so there is no new code to review.`,
      ], cwd);

      await ghAsTechLeadAsync([
        "pr", "merge", prNumber,
        "--repo", repo,
        "--merge",
      ], cwd);

      logger?.info(`Sync PR #${prNumber} created and merged immediately`);
    } catch (mergeErr) {
      // Expected on any repo with required status checks: the merge is attempted
      // seconds after creation, while build/test/typecheck are still IN_PROGRESS,
      // so branch protection refuses it. Not fatal — `tryMergeSyncPR` retries on a
      // later cycle once the checks land. See its comment for why that retry is
      // load-bearing rather than cosmetic.
      logger?.warn(`Sync PR #${prNumber} created but immediate auto-merge failed (will retry next cycle): ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
    }

    return prUrl;
  } catch (err) {
    logger?.warn("createSyncPR: gh pr create failed", { ...formatGhError(err), repo, behindBy });
    return null;
  }
}

/**
 * Merge an already-open sync PR. Returns true only if it is merged afterwards.
 *
 * WHY THIS EXISTS (2026-07-30). `createSyncPR` approves and merges the instant it
 * creates the PR — seconds later, while required status checks are still
 * IN_PROGRESS. On any repo with branch protection that merge is refused. The old
 * code caught that, said "the PR still exists for manual merge", and moved on;
 * the caller then logged "Sync PR created and auto-merged" regardless, and on
 * every later cycle logged "Sync PR already open" and returned early WITHOUT ever
 * retrying. So the merge never happened, the log claimed it had, and the sync PR
 * stayed open forever.
 *
 * That is not cosmetic. `develop` stays behind `main`, which makes the next
 * promotion PR `BEHIND`, which branch protection refuses to merge. Observed on
 * `console#779`: open 2h48m across ~140 no-op cycles, blocking the
 * promotion of #782 until it was merged by hand. The same "created and
 * auto-merged" line had already been logged for #438, #559 and #783.
 *
 * Idempotent by construction: re-approving an approved PR and merging a merged
 * PR are both no-ops we treat as success, so retrying every cycle is safe.
 */
export async function tryMergeSyncPR(
  repo: string,
  prNumber: number,
  cwd: string,
  logger?: Logger,
  productionBranch = "main",
): Promise<boolean> {
  try {
    // Re-approve defensively: on the retry path the original approval is already
    // there, and gh treats a repeat approval as a no-op.
    try {
      await ghAsTechLeadAsync([
        "pr", "review", String(prNumber),
        "--repo", repo,
        "--approve",
        "--body", `Branch sync: head is \`${productionBranch}\`, so there is no new code to review.`,
      ], cwd);
    } catch {
      // Already approved, or approval not required. Not a reason to skip the merge.
    }

    // As the Tech Lead, never the Foreman — see createSyncPR.
    await ghAsTechLeadAsync([
      "pr", "merge", String(prNumber),
      "--repo", repo,
      "--merge",
    ], cwd);
    clearMergeRefusal(repo, prNumber);
    return true;
  } catch (err) {
    // Still blocked (checks pending, conflict, protection). Per cycle that is a debug fact; the
    // durable state (the same refusal cycle after cycle) is reported by `noteMergeRefusal`.
    const message = err instanceof Error ? err.message : String(err);
    logger?.debug(`Sync PR #${prNumber} not mergeable yet: ${message}`);
    const { state, head } = await readMergeState(repo, prNumber, cwd);
    // Only a sync branch is updated. An older sync PR whose head is the production branch itself is left
    // alone: updating it would merge the base into production. It is named in the stall warning instead.
    if (state === "BEHIND" && head && head !== productionBranch) await updateBehindBranch(repo, prNumber, cwd, logger);
    noteMergeRefusal(repo, prNumber, state ?? "UNKNOWN", message, logger);
    return false;
  }
}

/** The PR's `mergeStateStatus` (BEHIND, DIRTY, BLOCKED, UNSTABLE, ...) and head branch; null when unreadable. */
async function readMergeState(repo: string, prNumber: number, cwd: string): Promise<{ state: string | null; head: string | null }> {
  try {
    const out = await ghAsTechLeadAsync(["pr", "view", String(prNumber), "--repo", repo, "--json", "mergeStateStatus,headRefName", "--jq", '.mergeStateStatus + " " + .headRefName'], cwd);
    const [state, head] = out.trim().split(" ");
    return { state: state || null, head: head || null };
  } catch {
    return { state: null, head: null };
  }
}

/** Update a BEHIND sync branch (never the production branch); the next cycle's retry merges it. */
async function updateBehindBranch(repo: string, prNumber: number, cwd: string, logger?: Logger): Promise<void> {
  try {
    await ghAsTechLeadAsync(["api", "-X", "PUT", `repos/${repo}/pulls/${prNumber}/update-branch`], cwd);
    logger?.info(`Sync PR #${prNumber} was behind its base — branch updated, merge retried next cycle`);
  } catch (err) {
    logger?.warn(`Sync PR #${prNumber} is behind its base and the branch update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A feature PR whose merge is not done and whose head is BEHIND its base is not cleared by waiting: with
 * `strict` branch protection it stays unmergeable until the branch is updated. Only BEHIND is updated; a
 * conflict or a failing check is not fixed by a base merge, and is counted toward the stall warning.
 * The head moves, so the next cycle's review judges the new head and merges it. Returns true when the branch was updated.
 */
export async function recoverBehindPr(repo: string, prNumber: number, cwd: string, logger?: Logger): Promise<boolean> {
  let state: string | null;
  try {
    state = (await ghAsync(["pr", "view", String(prNumber), "--repo", repo, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"], cwd)).trim() || null;
  } catch {
    return false;
  }
  if (!state) return false;
  if (state !== "BEHIND") {
    if (state === "CLEAN") clearMergeRefusal(repo, prNumber);
    else noteMergeRefusal(repo, prNumber, state, `merge state ${state}`, logger);
    return false;
  }
  try {
    await ghAsync(["api", "-X", "PUT", `repos/${repo}/pulls/${prNumber}/update-branch`], cwd);
    logger?.info(`PR #${prNumber} was behind its base — branch updated; the next cycle reviews and merges the new head`);
    noteMergeRefusal(repo, prNumber, "BEHIND", "behind its base", logger);
    return true;
  } catch (err) {
    logger?.warn(`PR #${prNumber} is behind its base and the branch update failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Consecutive cycles a PR has been refused for the same state before the stall is a warning. */
export const MERGE_STALL_WARN_CYCLES = 5;
const refusals = new Map<string, { state: string; cycles: number; since: number }>();

/**
 * "Not mergeable yet" is a fact about this cycle; a PR refused for the same state across
 * MERGE_STALL_WARN_CYCLES cycles has not moved. Warn then, and every that-many cycles after,
 * with the state and how long it has been stuck, at the default log level.
 */
export function noteMergeRefusal(repo: string, prNumber: number, state: string, message: string, logger?: Logger, now = Date.now()): void {
  const key = `${repo}#${prNumber}`;
  const prev = refusals.get(key);
  const cur = prev && prev.state === state ? { ...prev, cycles: prev.cycles + 1 } : { state, cycles: 1, since: now };
  refusals.set(key, cur);
  if (cur.cycles % MERGE_STALL_WARN_CYCLES === 0) {
    const minutes = Math.round((now - cur.since) / 60_000);
    logger?.warn(`PR ${key} refused for ${cur.cycles} consecutive cycles (${minutes} min), merge state ${state}: ${message.split("\n")[0]}`);
  }
}

/** Forget a PR's refusal history (it merged). */
export function clearMergeRefusal(repo: string, prNumber: number): void {
  refusals.delete(`${repo}#${prNumber}`);
}
