// Which branches the Foreman owns (#208). Every issue is built on its own branch
// `<branchPrefix><issue>-<slug>` cut from baseBranch. A PR is Foreman-owned iff its head
// starts with branchPrefix, or equals the LEGACY shared featureBranch (so PRs open at the
// cutover drain normally). This is the ONE ownership test: revise, reconcile and branch
// deletion all go through it, so a human-named head is never pushed to, revised or deleted.

import type { RepoConfig } from "./config.js";

export const DEFAULT_BRANCH_PREFIX = "foreman/";

type OwnershipConfig = Pick<RepoConfig, "featureBranch"> & { branchPrefix?: string };

/** The configured prefix; the default when the config predates it. Never empty. */
export function branchPrefixOf(config: { branchPrefix?: string }): string {
  return config.branchPrefix || DEFAULT_BRANCH_PREFIX;
}

/** The legacy shared branch `head` names (never the base), if the config sets one. */
export function isLegacyFeatureHead(config: OwnershipConfig, head: string): boolean {
  return !!config.featureBranch && head === config.featureBranch;
}

/** True iff the Foreman owns `head`: starts with branchPrefix, or is the legacy featureBranch. */
export function isForemanOwnedHead(config: OwnershipConfig, head: string | undefined | null): boolean {
  if (!head) return false;
  return head.startsWith(branchPrefixOf(config)) || isLegacyFeatureHead(config, head);
}

/**
 * The branch a sync PR comes from (`productionBranch` merged back into `baseBranch`). It carries the Foreman's
 * prefix, so it is Foreman-owned (never deleted or pushed to by a person's rules), but it is NOT a feature PR.
 */
export function syncBranchName(productionBranch: string, baseBranch: string): string {
  return `foreman/sync-${productionBranch}-into-${baseBranch}`;
}

/**
 * True iff `head` is one of the repo's feature-PR heads: Foreman-owned and not its sync branch (nor the production
 * branch, the head an older Foreman opened sync PRs from). A sync PR is the promote stage's (`tryMergeSyncPR`); counted
 * as a feature PR it held the repo's one build slot and was handed the revisions of another issue's PR
 * (2026-11-28: a sync PR that could not merge left an approved issue unbuilt, and another PR's change request was
 * "revised" on the sync PR).
 */
export function isForemanFeatureHead(
  config: OwnershipConfig & { productionBranch?: string; baseBranch?: string },
  head: string | undefined | null,
): boolean {
  if (!isForemanOwnedHead(config, head)) return false;
  if (config.productionBranch && config.baseBranch) {
    if (head === syncBranchName(config.productionBranch, config.baseBranch) || head === config.productionBranch) return false;
  }
  return true;
}

/** Lowercase, non-alphanumerics to `-`, collapsed, trimmed, at most `max` chars with no trailing `-`. */
export function slugify(title: string, max = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** The exact branch an issue is built on: `<branchPrefix><issue>-<slug>` (`<prefix><issue>` when the title has no slug). */
export function foremanBranchName(config: { branchPrefix?: string }, issueNumber: number, title: string): string {
  const slug = slugify(title);
  return `${branchPrefixOf(config)}${issueNumber}${slug ? `-${slug}` : ""}`;
}
