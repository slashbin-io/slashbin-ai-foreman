// A sync PR refused because its head is BEHIND its base is branch-updated (strict protection never
// clears it by waiting); any other refusal is not; a refusal repeated across cycles is a warn.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { tryMergeSyncPR, sweepOpenPrStates, createSyncPR, noteMergeRefusal, MERGE_STALL_WARN_CYCLES } from "../dist/github/branch.js";

const dir = mkTmp("fake-gh-behind-");
const log = join(dir, "calls");
const stateFile = join(dir, "state");
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "pr merge") echo "Pull request is not mergeable" >&2; exit 1;;
  "pr view") cat "${stateFile}";;
  "pr list") cat "${dir}/list";;
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

const list = (...prs) => writeFileSync(join(dir, "list"), JSON.stringify(prs.map(([number, state, head = "em/x", isDraft = false]) => ({ number, mergeStateStatus: state, headRefName: head, isDraft }))));

test("the sweep updates a BEHIND feature PR and no other state", async () => {
  reset("");
  list([7, "BEHIND"], [8, "DIRTY"], [9, "UNSTABLE"], [10, "BLOCKED"], [11, "CLEAN"], [12, "BEHIND", "em/d", true]);
  assert.deepEqual(await sweepOpenPrStates("o/r", "develop", "main", tmpdir(), logger), [7]);
  const c = calls();
  assert.match(c, /api -X PUT repos\/o\/r\/pulls\/7\/update-branch/);
  assert.equal((c.match(/update-branch/g) || []).length, 1);
});

test("the sweep never updates a sync PR, production-headed or on a sync branch", async () => {
  reset("");
  list([5, "BEHIND", "main"], [6, "BEHIND", "foreman/sync-main-into-develop"]);
  assert.deepEqual(await sweepOpenPrStates("o/r", "develop", "main", tmpdir(), logger), []);
  assert.doesNotMatch(calls(), /update-branch/);
});

// The sweep reads only `mergeStateStatus`: a PR the review will not be offered again (a current approval,
// spent attempts) is observed exactly like any other.
for (const [state, pr] of [["DIRTY", 21], ["BLOCKED", 22]]) {
  test(`an approved feature PR that stays ${state} warns once on its fifth consecutive sweep, naming state and count`, async () => {
    reset("");
    list([pr, state]);
    for (let i = 0; i < MERGE_STALL_WARN_CYCLES; i++) await sweepOpenPrStates("o/r", "develop", "main", tmpdir(), logger);
    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], new RegExp(`#${pr} refused for 5 consecutive cycles .*${state}`));
    assert.doesNotMatch(calls(), /update-branch/);
  });
}

test("a BEHIND sync PR headed by the production branch is closed so a dedicated one replaces it", async () => {
  reset("BEHIND main");
  assert.equal(await tryMergeSyncPR("o/r", 6, tmpdir(), logger, "main"), false);
  assert.match(calls(), /pr close 6 --repo o\/r --comment/);
  assert.doesNotMatch(calls(), /update-branch/);
});

test("a BEHIND sync PR on a sync branch is updated", async () => {
  reset("BEHIND foreman/sync-main-into-develop");
  assert.equal(await tryMergeSyncPR("o/r", 6, tmpdir(), logger), false);
  assert.match(calls(), /api -X PUT repos\/o\/r\/pulls\/6\/update-branch/);
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
