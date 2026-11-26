// The builder preflight gate: before a build or revise session's branch goes to review, run QA's deterministic
// local check (`qa.mjs preflight --local`: page overflow, clipping, pixel change against the baseline) on the pushed
// head and hand its findings back to a fix session on the same branch. QA's `check --local` stays the independent
// gate; this only moves the cheap defects from after the Tech Lead's review to the build. It never blocks the PR:
// could-not-run and findings still unresolved after the rounds are said on the PR and the PR goes on.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, RepoConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { PreflightOutcome } from "../plugins/contract.js";
import { codeHost, qaFor } from "../plugins/registry.js";
import { revisePRFeedback } from "./revise-workflow.js";
import type { ClaudeTrust } from "../claude-trust.js";

/** The heading the comment opens with. */
export const PREFLIGHT_HEADING = "## Builder preflight";
/** Fix rounds after the first run: run, fix, run, fix, run. */
export const PREFLIGHT_MAX_FIX_ROUNDS = 2;

export type PreflightGateStatus =
  /** QA does not cover this repo, or cannot say, or the runner has no preflight: nothing ran. */
  | "not-covered"
  | "clean"
  /** Findings were fixed by the session and the last run was clean. */
  | "fixed"
  /** Findings remain after the rounds (or the fix session pushed nothing): said on the PR, the PR goes on. */
  | "unresolved"
  | "could-not-run";

export interface PreflightGateDeps {
  covers(): Promise<boolean | "unknown">;
  /** The branch's pushed head sha, or null when unreadable. */
  headSha(): Promise<string | null>;
  /** Null when this runner has no preflight. */
  run(sha: string, round: number): Promise<PreflightOutcome | null>;
  /** A fix session on the branch with QA's findings; true only when it pushed a commit. */
  fix(findings: string): Promise<boolean>;
  comment(body: string): Promise<void>;
  log(msg: string, level?: "info" | "warn"): void;
}

export function preflightComment(status: PreflightGateStatus, rounds: number, last: string, sha: string): string {
  const head = `${PREFLIGHT_HEADING}\n\nHead \`${sha.slice(0, 8)}\`. `;
  if (status === "fixed") return `${head}Found defects, fixed them in ${rounds} round${rounds === 1 ? "" : "s"}; the last run was clean.`;
  if (status === "could-not-run") return `${head}**Could not run** (this does not block the PR; QA's own check still runs): ${last.split("\n")[0].slice(0, 300)}`;
  return `${head}**Findings remain** after ${rounds} fix round${rounds === 1 ? "" : "s"}. They do not block the PR here; QA's check and the review decide.\n\n\`\`\`\n${last}\n\`\`\``;
}

/** The decision, with every edge injected. Never throws: a preflight failing is a log line, never a held PR. */
export async function runPreflightGate(deps: PreflightGateDeps): Promise<{ status: PreflightGateStatus; rounds: number }> {
  try {
    if ((await deps.covers()) !== true) return { status: "not-covered", rounds: 0 };
    let rounds = 0;
    for (;;) {
      const sha = await deps.headSha();
      if (!sha) { deps.log("builder preflight: the branch head could not be read; not run", "warn"); return { status: "could-not-run", rounds }; }
      const out = await deps.run(sha, rounds);
      if (out === null) return { status: "not-covered", rounds };
      if (out.kind === "clean") {
        if (rounds > 0) await deps.comment(preflightComment("fixed", rounds, out.summary, sha));
        return { status: rounds > 0 ? "fixed" : "clean", rounds };
      }
      if (out.kind === "could-not-run") {
        await deps.comment(preflightComment("could-not-run", rounds, out.summary, sha));
        return { status: "could-not-run", rounds };
      }
      if (rounds >= PREFLIGHT_MAX_FIX_ROUNDS) {
        await deps.comment(preflightComment("unresolved", rounds, out.summary, sha));
        return { status: "unresolved", rounds };
      }
      rounds += 1;
      deps.log(`builder preflight: findings on ${sha.slice(0, 8)}; fix round ${rounds}`);
      if (!(await deps.fix(out.summary))) {
        await deps.comment(preflightComment("unresolved", rounds - 1, out.summary, sha));
        return { status: "unresolved", rounds: rounds - 1 };
      }
    }
  } catch (e) {
    deps.log(`builder preflight: errored, the PR goes on: ${e instanceof Error ? e.message : String(e)}`, "warn");
    return { status: "could-not-run", rounds: 0 };
  }
}

/** The real edges for PR `pr` (head `headBranch`, closing `issueNumbers`) of `repoConfig`. */
export function realPreflightDeps(
  trust: ClaudeTrust, repoConfig: RepoConfig, config: AgentConfig, logger: Logger, signal: AbortSignal | undefined,
  pr: number, headBranch: string, issueNumbers: number[],
): PreflightGateDeps {
  const host = codeHost();
  return {
    covers: async () => { const qa = await qaFor(repoConfig, config); return qa === "unknown" ? "unknown" : qa !== undefined; },
    headSha: () => host.getRemoteBranchSha(repoConfig.githubRepo, headBranch, repoConfig.repoPath, logger),
    run: async (sha, round) => {
      const qa = await qaFor(repoConfig, config);
      if (!qa || qa === "unknown" || !qa.preflight) return null;
      const out = join(homedir(), ".cache", "foreman-qa", "preflight", repoConfig.githubRepo.replace("/", "__"), String(pr), String(round));
      mkdirSync(out, { recursive: true });
      return qa.preflight(repoConfig, config, { repo: repoConfig.githubRepo, ref: sha, out }, logger);
    },
    fix: async (findings) => {
      const r = await revisePRFeedback(trust, repoConfig, logger, signal, pr, issueNumbers, findings, undefined, headBranch, "preflight");
      return r.success && !r.noCommit;
    },
    comment: (body) => host.commentOnPr(repoConfig, pr, body),
    log: (msg, level = "info") => logger[level](msg),
  };
}

/**
 * After a build or revise session pushed to PR `pr`: run the gate with the real edges. Called by the phases before the
 * label moves; never throws and never blocks.
 */
export async function preflightBeforeReview(
  trust: ClaudeTrust, repoConfig: RepoConfig, config: AgentConfig, logger: Logger, signal: AbortSignal | undefined,
  pr: { number: number; headBranch: string }, issueNumbers: number[],
): Promise<PreflightGateStatus> {
  const r = await runPreflightGate(realPreflightDeps(trust, repoConfig, config, logger, signal, pr.number, pr.headBranch, issueNumbers));
  if (r.status !== "not-covered") logger.info(`builder preflight on PR #${pr.number}: ${r.status} (${r.rounds} fix round${r.rounds === 1 ? "" : "s"})`);
  return r.status;
}
