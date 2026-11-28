// 2026-11-28: after the idle-poll fix the Foreman still spent ~3,776 GraphQL points an hour; `pr list` from the
// merge-state sweep (~1,560) and a `pr view` per carried merge (~600) led. A sweep result is replayed while the
// fleet state's PR versions and the base branch are unchanged, and dropped by any write to the repo; carried
// merges are read with one `pr list` instead of a `pr view` each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { fleetState } from "../dist/github-state.js";
import { configureIssueCache } from "../dist/github/cache.js";
import { sweepOpenPrStates, configureSweepGate } from "../dist/github/branch.js";
import { ghAsync } from "../dist/github/gh.js";
import { listCarriedMerges, configureCarryGate } from "../dist/github/release-carry.js";
import { createLogger } from "../dist/logger.js";

const dir = mkTmp("fake-gh-reuse-");
const log = join(dir, "calls");
const mergeState = join(dir, "state");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$1 $2 $3" >> "${log}"
case "$1 $2" in
  "pr list")
    case "$*" in
      *merged*) printf '[{"number":5,"state":"MERGED","title":"a","body":"Closes #40","headRefName":"x","commits":[]},{"number":7,"state":"MERGED","title":"b","body":"Closes #41","headRefName":"y","commits":[]}]' ;;
      *) printf '[{"number":7,"headRefName":"f7","isDraft":false,"mergeStateStatus":"%s"}]' "$(cat "${mergeState}")" ;;
    esac ;;
  "api repos/o/r/compare"*) printf '%s\\n' '{"sha":"a1","headline":"Merge pull request #5 from o/x"}' '{"sha":"a2","headline":"Merge pull request #7 from o/y"}' ;;
esac
exit 0
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.FOREMAN_GITHUB_TOKEN = "t-test-token";
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const lists = () => calls().filter((c) => c.startsWith("pr list")).length;

const logger = createLogger({ format: "text", level: "error" });
const conn = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const pr = (updatedAt) => ({ number: 7, url: "u/7", title: "t", body: "", state: "OPEN", headRefName: "f7", baseRefName: "develop", headRefOid: "h", updatedAt });
configureIssueCache({ ttlMs: 60_000 });
const setup = (updatedAt = "2026-11-28T11:59:00Z") => fleetState.configure({
  repos: ["a/x"], refreshMs: 30_000, logger,
  runAsync: async () => JSON.stringify({ data: { r0: { issues: conn([]), pullRequests: conn([pr(updatedAt)]) } } }),
});
let baseMoved = false;
const reset = (state = "CLEAN") => {
  writeFileSync(log, ""); writeFileSync(mergeState, state); baseMoved = false;
  configureSweepGate(async () => baseMoved);
  setup();
};
const sweep = () => sweepOpenPrStates("a/x", "develop", "main", tmpdir(), logger);

test("a quiet repo's sweep is read once, then replayed", async () => {
  reset();
  for (let i = 0; i < 5; i++) await sweep();
  assert.equal(lists(), 1);
});

test("a write to the repo on the same pass drops the replay", async () => {
  reset();
  await sweep();
  await ghAsync(["issue", "edit", "7", "--repo", "a/x", "--add-label", "x"], tmpdir());
  writeFileSync(log, "");
  await sweep();
  assert.equal(lists(), 1, "re-read after the write");
  await sweep();
  assert.equal(lists(), 1, "and replayed again after that");
});

test("a REST write to the repo drops it too", async () => {
  reset();
  await sweep();
  await ghAsync(["api", "--method", "POST", "repos/a/x/issues/7/comments", "-f", "body=x"], tmpdir());
  writeFileSync(log, "");
  await sweep();
  assert.equal(lists(), 1);
});

test("a base branch move re-reads", async () => {
  reset();
  await sweep();
  baseMoved = true;
  writeFileSync(log, "");
  await sweep();
  assert.equal(lists(), 1);
});

test("a changed PR (new update time in the fleet state) re-reads", async () => {
  reset();
  await sweep();
  setup("2026-11-28T12:30:00Z");
  writeFileSync(log, "");
  await sweep();
  assert.equal(lists(), 1);
});

test("no gate installed: every pass reads live", async () => {
  reset();
  configureSweepGate(null);
  await sweep(); await sweep();
  assert.equal(lists(), 2);
});

test("a BEHIND PR is never replayed: its update is retried live", async () => {
  reset("BEHIND");
  await sweep();
  writeFileSync(log, "");
  await sweep();
  assert.equal(lists(), 1);
  assert.ok(calls().some((c) => c.startsWith("api -X PUT") || c.startsWith("api -X")), "update-branch attempted again");
});

test("carried merges: one pr list, no pr view per merge", async () => {
  configureCarryGate(null);
  writeFileSync(log, "");
  const cfg = { githubRepo: "o/r", repoPath: tmpdir(), productionBranch: "main", baseBranch: "develop", github: { dependencyBranchPrefixes: [] } };
  const merges = await listCarriedMerges(cfg, logger);
  assert.deepEqual(merges.map((m) => [m.pr, m.issues]), [[5, [40]], [7, [41]]]);
  assert.equal(calls().filter((c) => c.startsWith("pr view")).length, 0);
  assert.equal(lists(), 1);
});
