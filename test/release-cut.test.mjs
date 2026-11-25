// The signed-only release cut (the 2026-11-24 case: two unsigned cards held signed
// #728 and #733 for 15 h). planCut is pure; applyCut runs real git against a bare origin in a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { planCut, applyCut, forgetCuts } from "../dist/github/release-cut.js";
import { releaseView } from "../dist/release-view.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

const m = (pr, issues, sha = `sha${pr}`) => ({ pr, sha, title: `PR ${pr}`, issues, exempt: false });

test("planCut holds back a merge with an unsigned issue and takes the rest in order", () => {
  const { picks, held } = planCut([m(727, [727]), m(728, [728]), m(737, [737]), m(733, [733])], new Set([727, 737]), new Set());
  assert.deepEqual(picks.map((p) => p.pr), [728, 733]);
  assert.deepEqual(held.map((p) => p.pr), [727, 737]);
});

test("planCut holds a merge when any one of its issues is unsigned, and never re-picks a shipped merge", () => {
  const { picks, held } = planCut([m(1, [10, 11]), m(2, []), m(3, [30])], new Set([11]), new Set([3]));
  assert.deepEqual(picks.map((p) => p.pr), [2]);
  assert.deepEqual(held.map((p) => p.pr), [1]);
});

test("releaseView is the cut only when releaseSignedOnly is on", () => {
  const c = loadConfig();
  const repo = { ...c, name: "r", githubRepo: "o/r", baseBranch: "develop", productionBranch: "main" };
  assert.equal(releaseView(repo), repo);
  const on = releaseView({ ...repo, github: { ...repo.github, releaseSignedOnly: true } });
  assert.equal(on.baseBranch, "release-cut");
  assert.equal(on.developBranch, "develop");
});

function fixture(conflicting = false) {
  const root = mkdtempSync(join(tmpdir(), "foreman-cut-"));
  const origin = join(root, "origin.git");
  const repoPath = join(root, "clone");
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, repoPath);
  sh(repoPath, "checkout", "-q", "-b", "main");
  writeFileSync(join(repoPath, "a.txt"), "base\n");
  sh(repoPath, "add", "."); sh(repoPath, "commit", "-q", "-m", "base");
  sh(repoPath, "push", "-q", "origin", "main");
  sh(repoPath, "checkout", "-q", "-b", "develop");
  const merges = [];
  const land = (pr, file, text) => {
    sh(repoPath, "checkout", "-q", "-b", `feat${pr}`, "develop");
    writeFileSync(join(repoPath, file), text);
    sh(repoPath, "add", "."); sh(repoPath, "commit", "-q", "-m", `work for ${pr}`);
    sh(repoPath, "checkout", "-q", "develop");
    sh(repoPath, "merge", "-q", "--no-ff", `feat${pr}`, "-m", `Merge pull request #${pr} from o/feat${pr}`);
    merges.push({ pr, sha: sh(repoPath, "rev-parse", "HEAD"), title: `PR ${pr}`, issues: [pr * 10], exempt: false });
  };
  land(1, "f1.txt", "one\n");
  land(2, "f2.txt", "two\n");
  land(3, conflicting ? "f2.txt" : "f3.txt", conflicting ? "two and three\n" : "three\n");
  sh(repoPath, "push", "-q", "origin", "develop");
  const config = { ...loadConfig(), name: "r", githubRepo: "o/r", repoPath, baseBranch: "develop", productionBranch: "main" };
  return { origin, repoPath, merges, config };
}

const tree = (origin, ref) => sh(origin, "ls-tree", "-r", "--name-only", ref).split("\n");

test("applyCut pushes production plus the signed merges only; an unsigned merge is never on it", async () => {
  forgetCuts();
  const { origin, merges, config } = fixture();
  const r = await applyCut(config, merges, new Set([20]), quiet);
  assert.equal(r.kind, "built");
  assert.deepEqual(r.picked, [1, 3]);
  assert.deepEqual(r.held, [2]);
  assert.deepEqual(tree(origin, "release-cut"), ["a.txt", "f1.txt", "f3.txt"]);
  assert.deepEqual(tree(origin, "main"), ["a.txt"]);
  // The picks keep the merge headline, so the carry read ties them to their issues.
  assert.match(sh(origin, "log", "release-cut", "--format=%s", "-n", "2"), /Merge pull request #3 from o\/feat3\nMerge pull request #1 from o\/feat1/);
  // The same plan again does not rebuild (a rebuild would move the release PR's head).
  assert.equal((await applyCut(config, merges, new Set([20]), quiet)).kind, "unchanged");
});

test("after the cut ships, the next cut takes only what was held back and nothing twice", async () => {
  forgetCuts();
  const { origin, repoPath, merges, config } = fixture();
  await applyCut(config, merges, new Set([20]), quiet);
  sh(repoPath, "fetch", "-q", "origin");
  sh(repoPath, "checkout", "-q", "main");
  sh(repoPath, "merge", "-q", "--no-ff", "origin/release-cut", "-m", "Merge pull request #900 from o/release-cut");
  sh(repoPath, "push", "-q", "origin", "main");
  const r = await applyCut(config, merges, new Set(), quiet);
  assert.equal(r.kind, "built");
  assert.deepEqual(r.picked, [2]);
  assert.deepEqual(tree(origin, "release-cut"), ["a.txt", "f1.txt", "f2.txt", "f3.txt"]);
});

test("a signed merge that needs the unsigned one before it fails closed and writes no cut", async () => {
  forgetCuts();
  const { origin, merges, config } = fixture(true);
  const r = await applyCut(config, merges, new Set([20]), quiet);
  assert.equal(r.kind, "failed");
  assert.match(r.reason, /PR #3|#3/);
  assert.equal(sh(origin, "branch", "--list", "release-cut"), "");
  assert.equal(existsSync(join(origin, "..", "clone", ".git", "CHERRY_PICK_HEAD")), false);
});
