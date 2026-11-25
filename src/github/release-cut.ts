// The signed-only release cut (post-mortem, 2026-11-24). A release PR (develop -> main) carries ALL of
// develop, and the EM sign-off gate is per issue, so one issue nobody had signed kept the status red and every
// signed card behind it waited (a service release: two unsigned cards held two signed ones for 15 h).
//
// With `github.releaseSignedOnly` on, the release PR's head is not develop. It is `releaseCutBranch`: the
// production branch plus a cherry-pick of every merge on develop whose issues are all signed, in develop's order.
// An unsigned merge is never on it, so nothing unsigned can reach production by this PR, and the sign-off gate
// (which reads `production...head`) sees only signed work. A cherry-pick keeps the merge's headline, so the
// carry read ties each pick to its issues exactly as it does a merge on develop.
//
// Fails closed: a pick that conflicts (a signed merge that built on an unsigned one) or any failed read leaves
// the cut as it was and returns the reason; the promote and release stages then do not run on a guess.
// A merge already on production, as a pick or as itself, is never picked again: its PR number is in production's log.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.js";
import type { CarriedMerge } from "../code-host.js";
import type { Logger } from "../logger.js";
import { git } from "../git-exec.js";
import { getOpenIssues } from "./cache.js";
import { listCarriedMerges, mergedPrNumber } from "./release-carry.js";
import { unsignedIssues } from "./release-signoff.js";

export type CutResult =
  | { kind: "built"; sha: string; picked: number[]; held: number[] }
  | { kind: "unchanged" }
  | { kind: "failed"; reason: string };

/**
 * Which merges ride the cut: not already on production, and none of their issues unsigned. Pure.
 * `held` are the merges kept off it, in order.
 */
export function planCut(
  merges: readonly CarriedMerge[],
  unsigned: ReadonlySet<number>,
  shipped: ReadonlySet<number>,
): { picks: CarriedMerge[]; held: CarriedMerge[] } {
  const picks: CarriedMerge[] = [];
  const held: CarriedMerge[] = [];
  for (const m of merges) {
    if (shipped.has(m.pr)) continue;
    (m.issues.some((n) => unsigned.has(n)) ? held : picks).push(m);
  }
  return { picks, held };
}

/** What the last build covered, per repo: production's tip and the picks. An identical plan is not rebuilt (a rebuild moves the head). */
const lastCut = new Map<string, string>();
export function forgetCuts(): void { lastCut.clear(); }

const IDENTITY = ["-c", "user.name=slashbin-foreman", "-c", "user.email=foreman@users.noreply.github.com"];

/** Rebuild `releaseCutBranch` from production plus the signed merges on the base branch. */
export async function cutRelease(
  config: RepoConfig,
  logger: Logger,
  foremanSigned: (n: number) => boolean | Promise<boolean>,
): Promise<CutResult> {
  const { githubRepo: repo, repoPath: cwd, baseBranch: base } = config;
  const unresolved: number[] = [];
  const merges = await listCarriedMerges(config, logger, unresolved);
  if (merges === null) return { kind: "failed", reason: `could not read what ${base} carries` };
  if (unresolved.length > 0) return { kind: "failed", reason: `merged PR ${unresolved.map((n) => `#${n}`).join(", ")} could not be read` };

  const carried = new Set(merges.filter((m) => !m.exempt).flatMap((m) => m.issues));
  const unsigned = new Set(await unsignedIssues(await getOpenIssues(repo, cwd, logger), carried, config.lifecycleLabels, foremanSigned));
  return applyCut(config, merges, unsigned, logger);
}

/** The git half of `cutRelease`: build the cut from `merges` minus those holding an `unsigned` issue, and push it. */
export async function applyCut(config: RepoConfig, merges: readonly CarriedMerge[], unsigned: ReadonlySet<number>, logger: Logger): Promise<CutResult> {
  const { githubRepo: repo, repoPath: cwd, productionBranch: prod, baseBranch: base } = config;
  const cutBranch = config.github.releaseCutBranch;
  let work: string | null = null;
  try {
    await git(["fetch", "--quiet", "origin", prod, base], cwd, { timeoutMs: 120_000 });
    const prodSha = await git(["rev-parse", `origin/${prod}`], cwd);
    const shipped = new Set<number>();
    for (const line of (await git(["log", `origin/${prod}`, "-n", "2000", "--format=%s"], cwd)).split("\n")) {
      const n = mergedPrNumber(line);
      if (n !== null) shipped.add(n);
    }
    const { picks, held } = planCut(merges, unsigned, shipped);
    const signature = `${prodSha}|${picks.map((p) => p.sha).join(",")}`;
    if (lastCut.get(repo) === signature) return { kind: "unchanged" };

    work = mkdtempSync(join(tmpdir(), "foreman-cut-"));
    await git(["worktree", "add", "--quiet", "--detach", work, prodSha], cwd);
    for (const p of picks) {
      const parents = (await git(["rev-list", "--parents", "-n", "1", p.sha], work)).split(" ").length - 1;
      try {
        await git([...IDENTITY, "cherry-pick", "--keep-redundant-commits", ...(parents > 1 ? ["-m", "1"] : []), p.sha], work);
      } catch (err) {
        await git(["cherry-pick", "--abort"], work).catch(() => undefined);
        const why = err instanceof Error ? err.message : String(err);
        return { kind: "failed", reason: `signed PR #${p.pr} does not apply to ${prod} without the unsigned work before it (${why}); the release waits` };
      }
    }
    const sha = await git(["rev-parse", "HEAD"], work);
    await git(["push", "--quiet", "--force", "origin", `${sha}:refs/heads/${cutBranch}`], work, { timeoutMs: 120_000 });
    lastCut.set(repo, signature);
    logger.info(`Release cut ${cutBranch}: ${picks.length} signed merge(s) on ${prod}, ${held.length} unsigned held back (${held.map((h) => `#${h.pr}`).join(", ") || "none"})`);
    return { kind: "built", sha, picked: picks.map((p) => p.pr), held: held.map((h) => h.pr) };
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (work) {
      await git(["worktree", "remove", "--force", work], cwd).catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
    }
  }
}
