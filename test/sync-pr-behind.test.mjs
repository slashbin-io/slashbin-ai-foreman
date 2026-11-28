// A sync PR refused because its head is BEHIND its base is branch-updated (strict protection never
// clears it by waiting); any other refusal is not; a refusal repeated across cycles is a warn.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { tryMergeSyncPR, noteMergeRefusal, MERGE_STALL_WARN_CYCLES } from "../dist/github/branch.js";

const dir = mkTmp("fake-gh-behind-");
const log = join(dir, "calls");
const stateFile = join(dir, "state");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "pr merge") echo "Pull request is not mergeable" >&2; exit 1;;
  "pr view") cat "${stateFile}";;
esac
exit 0
`);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.TECHLEAD_GITHUB_KEY = "t-test-token";
const lines = { info: [], warn: [] };
const logger = { debug() {}, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error() {}, child() { return this; } };
const reset = (state) => { writeFileSync(log, ""); writeFileSync(stateFile, state); lines.info = []; lines.warn = []; };
const calls = () => readFileSync(log, "utf8");

test("a BEHIND refusal updates the branch", async () => {
  reset("BEHIND");
  assert.equal(await tryMergeSyncPR("o/r", 7, tmpdir(), logger), false);
  assert.match(calls(), /api -X PUT repos\/o\/r\/pulls\/7\/update-branch/);
});

for (const state of ["DIRTY", "UNSTABLE", "BLOCKED"]) {
  test(`a ${state} refusal does not update the branch`, async () => {
    reset(state);
    assert.equal(await tryMergeSyncPR("o/r", 8, tmpdir(), logger), false);
    assert.doesNotMatch(calls(), /update-branch/);
  });
}

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
