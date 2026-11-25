// The release stages' view of a repo (github.releaseSignedOnly): their "base branch" is the signed-only cut.
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { codeHost } from "./plugins/registry.js";

/** The release PR's head for `config`: the cut when the repo ships signed-only, else the base branch. Pure. */
export function releaseView(config: RepoConfig): RepoConfig {
  if (!config.github.releaseSignedOnly || config.baseBranch === config.productionBranch) return config;
  return { ...config, developBranch: config.baseBranch, baseBranch: config.github.releaseCutBranch };
}

/** Rebuild the cut, then the view; null when it could not be built (the release waits, nothing is promoted on a guess). */
export async function releaseViewWithCut(config: RepoConfig, logger: Logger): Promise<RepoConfig | null> {
  if (releaseView(config) === config) return config;
  const cut = await codeHost().cutRelease(config, logger);
  if (cut.kind === "failed") {
    logger.warn(`${config.name}: the signed-only release cut was not built: ${cut.reason}`);
    return null;
  }
  return releaseView(config);
}
