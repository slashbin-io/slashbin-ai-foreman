// Review intake: a repo whose registry process mode is `review-only` is one the Foreman does not build, yet each
// of its open PR heads needs the Tech Lead's `techlead/review` status before it can merge. This starts that review,
// once per head. Called only from `tryReview`.
//
// The status on the head is the only record of review state. The Foreman writes none: the Tech Lead writes every
// state, `pending` included, so intake only reads statuses and offers the head (`review-pr --sha <head> --no-merge`).
//
//   no status                              -> offer
//   pending, older than reviewMaxDurationMs -> offer again (the review died without finishing)
//   pending, younger                        -> in flight, leave it
//   success                                 -> done (an approval, or "not applicable: ...")
//   failure, a REQUEST_CHANGES verdict      -> leave it until the head changes
//   failure, any other description          -> the review could not complete: offer again
//
// A registry that cannot answer, or has no whole-repo row, skips the repo and writes nothing: there is no
// fallback to a last known mode.

import type { AgentConfig, RepoConfig } from "./config.js";
import type { CodeHost, HeadStatus } from "./code-host.js";
import type { Logger } from "./logger.js";
import type { HeadReview } from "./plugins/contract.js";
import { codeHost, roleFor, repoProcessMode } from "./plugins/registry.js";
import type { CycleEvent } from "./phases/common.js";
import type { ForemanRuntime } from "./runtime.js";
import { MAX_REVIEW_ATTEMPTS_PER_HEAD } from "./step-attempts.js";

/** The commit-status context the Tech Lead writes. */
export const REVIEW_STATUS_CONTEXT = "techlead/review";
/** The registry process mode whose PRs are reviewed but never built or merged by the Foreman. */
export const REVIEW_ONLY_MODE = "review-only";

/** A failure description that is a verdict on the head, never an incomplete review. */
const VERDICT_FAILURE = /^(request[_ -]?changes|changes requested)\b/i;

/** What intake reads and calls; the defaults are the live registry, code host and reviewer. Tests pass fakes. */
export interface ReviewIntakeDeps {
  /** The repo's registry process mode. Throws when the registry cannot answer. */
  processMode(githubRepo: string): Promise<string | null>;
  host: Pick<CodeHost, "listOpenPrHeads" | "readHeadStatus" | "requiresStatusCheck">;
  reviewHead: ((repo: RepoConfig, pr: number, sha: string, logger: Logger) => Promise<HeadReview>) | undefined;
  now(): number;
}

function defaultDeps(config: AgentConfig): ReviewIntakeDeps {
  const reviewer = roleFor("reviewer", config);
  return {
    processMode: (githubRepo) => repoProcessMode(config, githubRepo),
    host: codeHost(),
    reviewHead: reviewer?.reviewHead ? (repo, pr, sha, logger) => reviewer.reviewHead!(repo, config, pr, sha, logger) : undefined,
    now: Date.now,
  };
}

/** Whether `status` on a head means the Tech Lead should be offered it. Pure, exported for tests. */
export function needsReview(status: HeadStatus | null, nowMs: number, maxPendingMs: number): boolean {
  if (!status) return true;
  if (status.state === "success") return false;
  if (status.state === "pending") {
    const at = Date.parse(status.updatedAt);
    return Number.isFinite(at) && nowMs - at > maxPendingMs;
  }
  // failure (or any state we do not know to be final): a verdict stands until the head moves, anything else re-offers.
  return !VERDICT_FAILURE.test(status.description.trim()) && status.state === "failure";
}

/**
 * One intake pass on one review-only repo. Offers at most one head (a review can run for an hour) and returns
 * true when it did, so the lane goes straight round again for the next.
 */
export async function runReviewIntake(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  events?: CycleEvent[],
  deps: ReviewIntakeDeps = defaultDeps(config),
): Promise<boolean> {
  const repo = repoConfig.githubRepo;
  let mode: string | null;
  try {
    mode = await deps.processMode(repo);
  } catch (err) {
    logger.warn(`Review intake skips ${repo}: the registry gave no process mode (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
  if (mode !== REVIEW_ONLY_MODE) return false;
  if (!deps.reviewHead) {
    logger.warn(`Review intake skips ${repo}: no reviewer that can review a single head is enabled`);
    return false;
  }

  try {
    if (!(await deps.host.requiresStatusCheck(repoConfig, REVIEW_STATUS_CONTEXT, logger))) {
      // Drift notice, once per repo: the review still starts, but no ruleset makes its status a merge gate.
      const key = `ruleset-drift:${repo}`;
      if (!rt.memory.observerEventsSent.has(key)) {
        rt.memory.observerEventsSent.add(key);
        events?.push({ message: `${repo} is review-only but no active ruleset requires ${REVIEW_STATUS_CONTEXT}: reviews still start, yet nothing blocks a merge without one`, level: "warn" });
      }
    }
  } catch (err) {
    logger.debug(`Review intake could not read ${repo}'s rulesets: ${err instanceof Error ? err.message : String(err)}`);
  }

  let heads;
  try {
    heads = await deps.host.listOpenPrHeads(repoConfig, logger);
  } catch (err) {
    logger.warn(`Review intake skips ${repo}: open PRs unreadable (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }

  for (const { number, sha } of heads) {
    let status: HeadStatus | null;
    try {
      status = await deps.host.readHeadStatus(repoConfig, sha, REVIEW_STATUS_CONTEXT, logger);
    } catch (err) {
      logger.warn(`Review intake: status of ${repo} PR #${number} unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!needsReview(status, deps.now(), config.reviewMaxDurationMs)) continue;

    const attemptKey = `${repo}#${number}@${sha}`;
    const tried = rt.memory.reviewIntakeAttempts.get(attemptKey) ?? 0;
    if (tried >= MAX_REVIEW_ATTEMPTS_PER_HEAD) {
      const noted = `intake-capped:${attemptKey}`;
      if (!rt.memory.observerEventsSent.has(noted)) {
        rt.memory.observerEventsSent.add(noted);
        events?.push({ message: `${repo} PR #${number} head ${sha.slice(0, 10)} was offered to the Tech Lead ${tried} times without a finished review; it waits for a new head`, level: "warn" });
      }
      continue;
    }

    const out = await deps.reviewHead(repoConfig, number, sha, logger);
    if (out.kind === "retry") {
      // The reviewer wrote nothing: not an attempt. Ask again on a later pass.
      logger.info(`Tech Lead could not take ${repo} PR #${number}: ${out.reason}; retried later`);
      return false;
    }
    rt.memory.reviewIntakeAttempts.set(attemptKey, tried + 1);
    if (out.kind === "done") {
      events?.push({ message: `Review started for ${repo} PR #${number} head ${sha.slice(0, 10)}`, level: "info" });
      return true;
    }
    logger.warn(`Tech Lead did not finish ${repo} PR #${number} (${out.kind}): ${out.reason}`);
    return true;
  }
  return false;
}
