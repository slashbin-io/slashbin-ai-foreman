// A PR hold (revision-stalemate, revision-exhausted, needs-ruling) is released once its PR is no longer open. Those holds
// cleared only from the PR (a push, a ruling), so a merge left the card in Blocked after the work shipped
// (2026-11-28: a docs PR merged with a stalemate standing, and the EM was asked five more times).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setStateDir } from "../dist/state-dir.js";
import { tryUnstick, resetDecomposeThrottle } from "../dist/phases/unstick.js";
import { prHoldPr } from "../dist/unstick.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { codeHost } from "../dist/plugins/registry.js";
import { addObserver, drainObservers } from "../dist/work-source.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, recordOf } from "./issue-records.mjs";

const ITEM = 763, PR = 835;
await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("closed-pr-gh-");
const openFile = join(ghBin, "open.json");
writeFileSync(openFile, JSON.stringify([{ number: ITEM, title: "t", labels: [{ name: "release pending" }] }]));
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(openFile)}\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prOpen = true;
const host = codeHost();
const realIsPrOpen = host.isPrOpen;
host.isPrOpen = async (_repo, pr) => (pr === PR ? prOpen : true);
test.after(() => { host.isPrOpen = realIsPrOpen; });
const events = [];
addObserver({ onEvent: async (e) => { events.push(e); } });

const STALEMATE = `reviewer and reviser disagree on PR #${PR} after 2 no-commit rounds — EM to rule, or push to the PR and the Foreman resumes. Last reason: see #12`;

async function world(holds) {
  events.length = 0;
  setStateDir(mkTmp("closed-pr-state-"));
  memoryRecords();
  resetDecomposeThrottle();
  const em = mkTmp("closed-pr-em-");
  mkdirSync(join(em, "bin"));
  const calls = join(em, "calls.log");
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "unstick") { fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n"); process.exit(1); }
console.log("[]");`);
  const repo = { name: "host", githubRepo: "o/host", repoPath: em, lifecycleLabels: { prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], repos: [repo], unstickEscalationOwner: "owner-login", backoff: { verifyRetry: { maxAttempts: 3 }, handoff: { baseMs: 1, capMs: 1, factor: 1, maxRecalls: 1 } } };
  const rt = new ForemanRuntime();
  for (const h of holds) assert.equal(await rt.handoffs.noteStuck(repo, ITEM, h.kind, h.reason), true);
  return {
    pass: async (i) => { dropIssueSnapshot("o/host"); await sleep(5); resetDecomposeThrottle(); const n = await tryUnstick(rt, repo, config, logger, i, { comment: () => {} }); await drainObservers(); return n; },
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0),
    questions: async () => Object.keys((await recordOf(rt, repo, ITEM)).unstick ?? {}),
    unblocked: () => events.filter((e) => e.kind === "unblocked" && e.item.issueNumber === ITEM),
  };
}

test("prHoldPr: the PR a PR hold names, and nothing for any other kind", () => {
  assert.equal(prHoldPr({ kind: "revision-stalemate", reason: STALEMATE }), PR);
  assert.equal(prHoldPr({ kind: "needs-ruling", reason: "PR #9 was reviewed 3 times at the same head" }), 9);
  assert.equal(prHoldPr({ kind: "revision-exhausted", reason: "Revision retries exhausted on PR #4: x" }), 4);
  assert.equal(prHoldPr({ kind: "verify-held", reason: "PR #4 failed dev" }), null);
  assert.equal(prHoldPr({ kind: "needs-ruling", reason: "no pr named" }), null);
});

test("an open PR keeps its stalemate hold and the EM is asked", async () => {
  prOpen = true;
  const w = await world([{ kind: "revision-stalemate", reason: STALEMATE }]);
  await w.pass(1);
  assert.deepEqual(await w.questions(), [`${ITEM}:revision-stalemate`]);
  assert.equal(w.unblocked().length, 0);
  assert.equal(w.calls(), 1);
});

test("a merged PR releases its stalemate hold: the card is unblocked and the EM is never called", async () => {
  for (const kind of ["revision-stalemate", "needs-ruling", "revision-exhausted"]) {
    prOpen = false;
    const w = await world([{ kind, reason: STALEMATE }]);
    await w.pass(1);
    assert.deepEqual(await w.questions(), [], kind);
    assert.equal(w.unblocked().length, 1, `${kind}: one unblocked event moves the card`);
    assert.equal(w.calls(), 0, kind);
  }
});

test("an unreadable PR keeps the hold", async () => {
  prOpen = null;
  const w = await world([{ kind: "revision-stalemate", reason: STALEMATE }]);
  await w.pass(1);
  assert.deepEqual(await w.questions(), [`${ITEM}:revision-stalemate`]);
  assert.equal(w.unblocked().length, 0);
});

test("another blocker on the issue: only the closed PR's hold is dropped, the card stays blocked", async () => {
  prOpen = false;
  const w = await world([{ kind: "revision-stalemate", reason: STALEMATE }, { kind: "verify-held", reason: "dev verification failed" }]);
  await w.pass(1);
  assert.deepEqual(await w.questions(), [`${ITEM}:verify-held`]);
  assert.equal(w.unblocked().length, 0);
});
