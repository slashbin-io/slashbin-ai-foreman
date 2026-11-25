// A blocked-by link to an issue in another repo is honoured like a same-repo one (the 2026-11-24 case:
// a service card held acceptance-not-verified, blocked by an issue in another repo; that issue closed as completed and the Foreman never
// released the hold, 4.5 h, until a hand-written ruling). A fake `gh` serves the real blocked_by rows' shape.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { dropCanonicalRepo } from "../dist/github/repo-identity.js";
import { githubCodeHost } from "../dist/plugins/github.js";
import { setCodeHost } from "../dist/plugins/registry.js";
import { correctionMergedSince } from "../dist/phases/verify.js";
import { unmetBlockers } from "../dist/github/blockers.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HELD_AT = "2026-11-24T19:03:09.375Z";

function fakeGh(blockedBy) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-xrepo-"));
  writeFileSync(join(dir, "blockedby.json"), JSON.stringify(blockedBy));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
d="${dir}"
case "$*" in
  *"/dependencies/blocked_by"*) cat "$d/blockedby.json" ;;
  *"api repos/"*"--jq .full_name"*) echo "o/r" ;;
  *) echo '[]' ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

async function withGh(dir, fn) {
  const saved = { PATH: process.env.PATH, T: process.env.FOREMAN_GITHUB_TOKEN };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.FOREMAN_GITHUB_TOKEN = "test";
  dropIssueSnapshot("o/r");
  dropCanonicalRepo();
  setCodeHost(githubCodeHost());
  try {
    return await fn({ ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: dir, baseBranch: "develop" });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.FOREMAN_GITHUB_TOKEN; else process.env.FOREMAN_GITHUB_TOKEN = saved.T;
  }
}

const row = (over) => ({ number: 609, labels: [], repository_url: "https://api.github.com/repos/o/other", created_at: "2026-11-24T18:37:00Z", ...over });

test("cross-repo blocker closed as completed after the hold releases it (the 11-24 case)", async () => {
  const dir = fakeGh([row({ state: "closed", state_reason: "completed", closed_at: "2026-11-24T21:59:03Z" })]);
  await withGh(dir, async (cfg) => assert.equal(await correctionMergedSince(cfg, 734, HELD_AT, quiet), true));
});

test("cross-repo blocker still open keeps the hold", async () => {
  const dir = fakeGh([row({ state: "open", state_reason: null, closed_at: null })]);
  await withGh(dir, async (cfg) => assert.equal(await correctionMergedSince(cfg, 734, HELD_AT, quiet), false));
});

test("cross-repo blocker closed as not planned does not release the hold", async () => {
  const dir = fakeGh([row({ state: "closed", state_reason: "not_planned", closed_at: "2026-11-24T21:59:03Z" })]);
  await withGh(dir, async (cfg) => assert.equal(await correctionMergedSince(cfg, 734, HELD_AT, quiet), false));
});

test("cross-repo blocker closed before the hold began is a prerequisite, not a correction", async () => {
  const dir = fakeGh([row({ state: "closed", state_reason: "completed", closed_at: "2026-11-24T10:00:00Z" })]);
  await withGh(dir, async (cfg) => assert.equal(await correctionMergedSince(cfg, 734, HELD_AT, quiet), false));
});

test("an unreadable blocker list is unknown, never released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-xrepo-"));
  writeFileSync(join(dir, "gh"), '#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n');
  chmodSync(join(dir, "gh"), 0o755);
  await withGh(dir, async (cfg) => assert.equal(await correctionMergedSince(cfg, 734, HELD_AT, quiet), undefined));
});

test("build gate: a cross-repo blocker holds while open and releases once closed", () => {
  const labels = loadConfig().lifecycleLabels;
  assert.equal(unmetBlockers([row({ state: "open" })], labels).length, 1);
  assert.equal(unmetBlockers([row({ state: "closed", state_reason: "completed" })], labels).length, 0);
});
