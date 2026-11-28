// A sync PR refused because its head is BEHIND its base is branch-updated (strict protection never
// clears it by waiting); any other refusal is not; a refusal repeated across cycles is a warn.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { tryMergeSyncPR, recoverBehindPr, createSyncPR, noteMergeRefusal, MERGE_STALL_WARN_CYCLES } from "../dist/github/branch.js";

const dir = mkTmp("fake-gh-behind-");
const log = join(dir, "calls");
const stateFile = join(dir, "state");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "pr merge") echo "Pull request is not mergeable" >&2; exit 1;;
  "pr view") cat "${stateFile}";;
  "pr create") echo "https://github.com/o/r/pull/99";;
  "api repos/o/r/git/ref/heads/develop") echo abc123;;
esac
exit 0
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.TECHLEAD_GITHUB_KEY = "t-test-token";
process.env.FOREMAN_GITHUB_TOKEN = "f-test-token";
const lines = { info: [], warn: [] };
const logger = { debug() {}, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error() {}, child() { return this; } };
const reset = (state) => { writeFileSync(log, ""); writeFileSync(stateFile, state); lines.info = []; lines.warn = []; };
const calls = () => readFileSync(log, "utf8");

test("a BEHIND feature PR has its branch updated", async () => {
  reset("BEHIND");
  assert.equal(await recoverBehindPr("o/r", 7, tmpdir(), logger), true);
  assert.match(calls(), /api -X PUT repos\/o\/r\/pulls\/7\/update-branch/);
});

for (const state of ["DIRTY", "UNSTABLE", "BLOCKED", "CLEAN"]) {
  test(`a ${state} feature PR is not branch-updated`, async () => {
    reset(state);
    assert.equal(await recoverBehindPr("o/r", 8, tmpdir(), logger), false);
    assert.doesNotMatch(calls(), /update-branch/);
  });
}

test("a BEHIND sync PR on a sync branch is updated", async () => {
  reset("BEHIND foreman/sync-main-into-develop");
  assert.equal(await tryMergeSyncPR("o/r", 6, tmpdir(), logger), false);
  assert.match(calls(), /api -X PUT repos\/o\/r\/pulls\/6\/update-branch/);
});

test("a BEHIND legacy sync PR whose head is the production branch is never updated", async () => {
  reset("BEHIND main");
  assert.equal(await tryMergeSyncPR("o/r", 6, tmpdir(), logger), false);
  assert.doesNotMatch(calls(), /update-branch/);
});

test("a DIRTY sync PR is not updated", async () => {
  reset("DIRTY foreman/sync-main-into-develop");
  assert.equal(await tryMergeSyncPR("o/r", 6, tmpdir(), logger), false);
  assert.doesNotMatch(calls(), /update-branch/);
});

test("createSyncPR cuts a sync branch from the base, merges production into it, and never writes production", async () => {
  reset("");
  await createSyncPR("o/r", "main", "develop", 2, tmpdir(), logger);
  const c = calls();
  assert.match(c, /git\/refs .*ref=refs\/heads\/foreman\/sync-main-into-develop/);
  assert.match(c, /merges -f base=foreman\/sync-main-into-develop -f head=main/);
  assert.match(c, /pr create .*--head foreman\/sync-main-into-develop/);
  assert.doesNotMatch(c, /base=main\b/);
});

test("the same refusal across cycles warns with state and cycle count; a changed state restarts the count", () => {
  reset("");
  const t0 = 1_000_000;
  for (let i = 1; i < MERGE_STALL_WARN_CYCLES; i++) noteMergeRefusal("o/r", 9, "DIRTY", "conflict", logger, t0 + i * 60_000);
  assert.equal(lines.warn.length, 0);
  noteMergeRefusal("o/r", 9, "DIRTY", "conflict", logger, t0 + 10 * 60_000);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /o\/r#9 refused for 5 consecutive cycles \(9 min\), merge state DIRTY/);
  noteMergeRefusal("o/r", 9, "BLOCKED", "x", logger, t0 + 11 * 60_000);
  for (let i = 0; i < 3; i++) noteMergeRefusal("o/r", 9, "BLOCKED", "x", logger, t0 + 12 * 60_000);
  assert.equal(lines.warn.length, 1);
});
