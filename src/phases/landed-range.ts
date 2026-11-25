// Landed range (slashbin-ai-foreman#393): commits that reach a lane repo's base branch without an approved PR are
// caught when they land, not when the release is promoted. The Foreman detects the move of `origin/<baseBranch>` and
// keeps the last head it had judged (`RepoRecord.landedHead`); the Tech Lead owns the provenance rule and the verdict
// (`reviewer.reviewLanded`). The Foreman never copies that rule and never blocks the base branch.
//
// Dark behind `FOREMAN_LANDED_REVIEW`: unset, nothing here reads a record, calls the Tech Lead or writes anything.

import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ForemanRuntime } from "../runtime.js";
import { roleFor } from "../plugins/registry.js";
import { HandoffNotSaved } from "../unstick.js";
import { asActiveRun, type CycleEvent } from "./common.js";

/** Whether the dark flag is on. Process-wide: read from the environment at each call, so a restart is the switch. */
export function landedReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FOREMAN_LANDED_REVIEW ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/** What one pass did, for the log and the tests. */
export type LandedOutcome =
  /** The flag is off, there is no reviewer, the base head or the repo record could not be read: nothing was done. */
  | "skipped"
  /** No head was recorded yet: the current one is, with no review (no backfill). */
  | "baseline"
  /** The base has not moved since the last judged head. */
  | "unchanged"
  /** COVERED or APPROVE: the head is recorded. */
  | "checked"
  /** REQUEST_CHANGES: one hand-off raised, then the head recorded. */
  | "changes-requested"
  /** No verdict, or it could not be recorded: the record stands and the next pass asks again for the range. */
  | "retry";

/** The hand-off's dedupe key: the range, so one range is one question. Pure, exported for tests. */
export const landedDedupeKey = (from: string, to: string): string => `${from}..${to}`;

/** The hand-off's reason. Stable (no timestamps), so a repeat raise is the same question. Pure, exported for tests. */
export function landedReason(githubRepo: string, base: string, from: string, to: string): string {
  return `${githubRepo} ${base}: commits ${from}..${to} landed without an approved PR, and the Tech Lead's review of the range ` +
    `asked for changes (its verdict is the commit comment on the newest unreviewed commit). The base branch is not blocked; ` +
    `file the corrective.`;
}

/**
 * After the reconcile pass's fetch: when `origin/<baseBranch>` (`baseHead`) differs from the recorded `landedHead`,
 * ask the reviewer about `landedHead..baseHead` once. Idempotent, and never throws: a failure is a `retry`.
 */
export async function reviewLandedRange(
  rt: ForemanRuntime,
  repoConfig: RepoConfig,
  config: AgentConfig,
  baseHead: string | null,
  logger: Logger,
  events: CycleEvent[],
): Promise<LandedOutcome> {
  if (!landedReviewEnabled()) return "skipped";
  const reviewer = roleFor("reviewer", config);
  if (!reviewer || !baseHead) return "skipped";
  try {
    const record = await rt.records.loadRepoRecord(repoConfig);
    if (!record) {
      logger.debug(`${repoConfig.githubRepo}: repo record unreadable; landed review waits`);
      return "skipped";
    }
    const from = record.landedHead;
    if (!from) {
      const wrote = await rt.records.updateRepoRecord(repoConfig, (d) => { if (!d.landedHead) d.landedHead = baseHead; });
      if (wrote) logger.info(`${repoConfig.githubRepo}: landed review baseline at ${repoConfig.baseBranch} ${baseHead.slice(0, 10)}`);
      return wrote ? "baseline" : "retry";
    }
    if (from === baseHead) return "unchanged";
    const to = baseHead;

    const review = await asActiveRun(repoConfig.name, (signal) => reviewer.reviewLanded(repoConfig, config, from, to, logger, signal));
    if (review.kind === "retry") {
      logger.warn(`${repoConfig.githubRepo}: landed review of ${from.slice(0, 10)}..${to.slice(0, 10)} gave no verdict (${review.reason}); retried next pass`);
      return "retry";
    }

    if (review.verdict === "REQUEST_CHANGES") {
      // Raised before the head is recorded: a hand-off that could not be saved repeats the review, it is never lost.
      try {
        await rt.handoffs.raise(repoConfig, {
          kind: "landed-changes-requested",
          subject: 0,
          dedupeKey: landedDedupeKey(from, to),
          reason: landedReason(repoConfig.githubRepo, repoConfig.baseBranch, from, to),
        });
      } catch (err) {
        if (!(err instanceof HandoffNotSaved)) throw err;
        logger.warn(`${repoConfig.githubRepo}: landed-changes-requested hand-off not saved; the range is reviewed again next pass`);
        return "retry";
      }
    }

    if (!(await rt.records.updateRepoRecord(repoConfig, (d) => { if (d.landedHead === from) d.landedHead = to; }))) {
      logger.warn(`${repoConfig.githubRepo}: landed head ${to.slice(0, 10)} not recorded; the range is reviewed again next pass`);
      return "retry";
    }
    if (review.verdict !== "REQUEST_CHANGES") {
      logger.info(`${repoConfig.githubRepo}: landed ${from.slice(0, 10)}..${to.slice(0, 10)} ${review.verdict}`);
      return "checked";
    }
    events.push({
      message: `⚠️ ${repoConfig.githubRepo} — commits ${from.slice(0, 10)}..${to.slice(0, 10)} reached \`${repoConfig.baseBranch}\` without an approved PR and the Tech Lead's range review asked for changes; handed to the EM.`,
      level: "warn",
    });
    return "changes-requested";
  } catch (err) {
    logger.warn(`${repoConfig.githubRepo}: landed review failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); retried next pass`);
    return "retry";
  }
}
