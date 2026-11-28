// The unstick pass reports a handoff that gives up and a due epic nobody answers to the stall clock (dark behind FOREMAN_STALL_CLOCK).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setStateDir } from "../dist/state-dir.js";
import { tryUnstick, resetDecomposeThrottle, heldEpics } from "../dist/phases/unstick.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { releaseGateReason } from "../dist/unstick.js";
import { report as reportStall } from "../dist/stall-clock.js";
import { memoryRecords, seed, recordOf, repoRecordOf, breakRecords } from "./issue-records.mjs";
import { existsSync, readFileSync } from "node:fs";

await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
const ghBin = mkTmp("stall-gh-");
const openFile = join(ghBin, "open.json");
writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(openFile)}\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVED = iso(Date.now() - 200 * 60_000), CLOSED = iso(Date.now() - 120 * 60_000);

function world({ flag = true, due = [] } = {}) {
  if (flag) process.env.FOREMAN_STALL_CLOCK = "1"; else delete process.env.FOREMAN_STALL_CLOCK;
  setStateDir(mkTmp("stall-state-"));
  memoryRecords();
  resetDecomposeThrottle();
  const em = mkTmp("stall-em-");
  mkdirSync(join(em, "bin"));
  writeFileSync(join(em, "due.json"), JSON.stringify(due));
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "decompose-candidates") { console.log(fs.readFileSync(${JSON.stringify(join(em, "due.json"))}, "utf8")); process.exit(0); }
if (a[0] === "unstick") { fs.appendFileSync(${JSON.stringify(join(em, "calls.log"))}, a.join(" ") + "\\n"); process.exit(1); }
console.log("[]");`);
  const repo = { name: "host", githubRepo: "o/host", repoPath: em, lifecycleLabels: { prApproved: "pr approved", readyForProd: "ready for prod release" }, epicRefLabel: "epic", epicRepo: "o/epics" };
  const config = { emRepoPath: em, sessionEnv: [], repos: [repo], epicRepo: "o/epics", unstickEscalationOwner: "owner-login", backoff: { verifyRetry: { maxAttempts: 3 }, handoff: { baseMs: 1, capMs: 1, factor: 1, maxRecalls: 1 } } };
  let rt = new ForemanRuntime();
  return {
    repo, em, get rt() { return rt; },
    restart() { rt = new ForemanRuntime(); resetDecomposeThrottle(); },
    setDue(d) { writeFileSync(join(em, "due.json"), JSON.stringify(d)); },
    pass: async (i) => { dropIssueSnapshot("o/host"); await sleep(5); resetDecomposeThrottle(); return tryUnstick(rt, repo, config, logger, i, { comment: () => {} }); },
    epicStall: async (n) => (await recordOf(rt, { ...repo, githubRepo: "o/epics" }, n)).stalls?.["epic-unanswered"],
    stall: async (n, cause) => (await recordOf(rt, repo, n)).stalls?.[cause],
    /** The EM calls about the `stalled` question of (issue, cause) so far. */
    stalledCalls: (n, cause) => (existsSync(join(em, "calls.log")) ? readFileSync(join(em, "calls.log"), "utf8") : "").split("\n").filter((l) => l.includes(`--issue ${n} --kind stalled`) && l.includes(cause)).length,
  };
}

test("a due epic's stall starts at afterClosedAt, else approvedAt, and a repeat keeps it", async () => {
  const w = world({ due: [{ epic: 11, approvedAt: APPROVED, after: "o/svc#3", afterClosedAt: CLOSED }, { epic: 12, approvedAt: APPROVED }, { epic: 13, approvedAt: APPROVED, after: "o/svc#4", afterClosedAt: null }] });
  await w.pass(1);
  assert.equal((await w.epicStall(11)).startedAt, CLOSED);
  assert.equal((await w.epicStall(12)).startedAt, APPROVED);
  assert.equal((await w.epicStall(13)).startedAt, APPROVED, "a null afterClosedAt falls back to approvedAt");
  assert.deepEqual((await w.epicStall(11)).affected, ["o/epics#11"]);
  await w.pass(2);
  assert.equal((await w.epicStall(11)).startedAt, CLOSED);
});

test("a restart between scans never leaves a stale epic stall open", async () => {
  const w = world({ due: [{ epic: 12, approvedAt: APPROVED }] });
  await w.pass(1);
  assert.notEqual((await w.epicStall(12)).state, "resolved"); // aged past the bound, the sweep may have escalated it
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).epicStalls, [12]);
  w.restart(); // the in-memory view of the prior scan is gone
  w.setDue([]);
  await w.pass(2);
  assert.equal((await w.epicStall(12)).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("flag off: nothing is written", async () => {
  const w = world({ flag: false, due: [{ epic: 12, approvedAt: APPROVED }] });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal(await w.epicStall(12), undefined);
  assert.equal(await w.stall(7, "handoff-gave-up"), undefined);
  assert.equal((await repoRecordOf(w.rt, w.repo)).epicStalls, undefined);
});

test("an epic's stall lives under the epic's repo and number, survives a restart and escalates there", async () => {
  const w = world({ due: [{ epic: 900, approvedAt: APPROVED }] });
  await w.pass(1);
  assert.equal((await recordOf(w.rt, w.repo, 900)).stalls, undefined, "nothing is written under the host's number 900");
  assert.equal(w.epicStall ? (await w.epicStall(900)).id : "", "o/epics#900:epic-unanswered");
  w.restart();
  await w.pass(2);
  const s = await w.epicStall(900);
  assert.equal(s.startedAt, APPROVED);
  assert.equal(s.state, "escalated", "aged past the bound, the sweep raised it from the durable index");
  const q = Object.values((await recordOf(w.rt, { ...w.repo, githubRepo: "o/epics" }, 900)).unstick ?? {});
  assert.deepEqual(q.map((e) => e.kind), ["stalled"]);
  assert.equal((await recordOf(w.rt, w.repo, 900)).unstick, undefined);
});

test("a give-up opens one handoff-gave-up stall that resolves when the hold clears", async () => {
  const w = world();
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  const s = await w.stall(7, "handoff-gave-up");
  assert.equal(s.state, "open");
  assert.equal(s.resolver, "owner-login");
  await seed(w.rt, w.repo, 7, { verifyHeld: undefined });
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

async function giveUp(w) {
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
}

test("a give-up on an issue that then closes resolves, also after a restart", async () => {
  const w = world();
  await giveUp(w);
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).handoffStalls, [7]);
  writeFileSync(openFile, "[]");
  w.restart();
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
});

test("a terminal EM answer resolves the give-up while the hold remains", async () => {
  const w = world();
  await giveUp(w);
  await w.rt.records.updateIssueRecord(w.repo, 7, (d) => { for (const e of Object.values(d.unstick ?? {})) { e.status = "declined"; e.lastCallAt = iso(Date.now() + 60_000); } });
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("a give-up with the flag off writes no index", async () => {
  const w = world({ flag: false });
  await seed(w.rt, w.repo, 7, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
});

test("flag off: a closed issue's open stall and its index are left alone, and resolve once tracking is back", async () => {
  const w = world();
  await giveUp(w);
  writeFileSync(openFile, "[]");
  delete process.env.FOREMAN_STALL_CLOCK;
  w.restart();
  await w.pass(4);
  assert.deepEqual((await repoRecordOf(w.rt, w.repo)).handoffStalls, [7]);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
  process.env.FOREMAN_STALL_CLOCK = "1";
  w.restart();
  await w.pass(5);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("an escalation after the Foreman's own give-up notice is the EM's answer; the notice itself is not", async () => {
  const w = world();
  await giveUp(w);
  const entry = async () => Object.values((await recordOf(w.rt, w.repo, 7)).unstick ?? {}).find((e) => e.status === "escalated");
  const local = await entry();
  assert.equal(local.status, "escalated");
  assert.ok(local.gaveUpAt, "the local notice stamps gaveUpAt");
  await w.pass(4);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open", "the local notice alone resolves nothing");
  await w.rt.records.updateIssueRecord(w.repo, 7, (d) => { for (const e of Object.values(d.unstick ?? {})) e.lastCallAt = iso(Date.now() + 60_000); });
  await w.pass(5);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
});

test("a batch of give-ups widens the index in one write, not one per issue", async () => {
  const w = world();
  const issues = Array.from({ length: 40 }, (_, i) => i + 100);
  writeFileSync(openFile, JSON.stringify(issues.map((number) => ({ number, title: "t", labels: [] }))));
  for (const n of issues) await seed(w.rt, w.repo, n, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  await w.pass(1);
  await w.pass(2);
  let saves = 0;
  const real = w.rt.records.updateRepoRecord.bind(w.rt.records);
  w.rt.records.updateRepoRecord = (...args) => { saves++; return real(...args); };
  await w.pass(3);
  assert.ok(saves < 10, `repo-record writes in the giving-up pass (40 issues): ${saves}`);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls.length, 40);
  for (const n of issues) assert.equal((await w.stall(n, "handoff-gave-up")).state, "open");
});

test("failed recalls of handed-off questions are indexed in one write too", async () => {
  const w = world();
  const issues = Array.from({ length: 40 }, (_, i) => i + 100);
  writeFileSync(openFile, JSON.stringify(issues.map((number) => ({ number, title: "t", labels: [] }))));
  for (const n of issues) await seed(w.rt, w.repo, n, { verifyHeld: { heldAt: "t", prNumber: 5, reason: "r", attempts: 3 } });
  await w.pass(1);
  for (const n of issues) await w.rt.records.updateIssueRecord(w.repo, n, (d) => { for (const e of Object.values(d.unstick ?? {})) { e.status = "invoked"; e.attempts = 2; e.recalls = 0; e.lastCallAt = iso(Date.now() - 3_600_000); } });
  let saves = 0;
  const real = w.rt.records.updateRepoRecord.bind(w.rt.records);
  w.rt.records.updateRepoRecord = (...args) => { saves++; return real(...args); };
  await w.pass(2);
  assert.ok(saves < 10, `repo-record writes (40 failed recalls): ${saves}`);
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls?.length, 40);
});

test("heldEpics reads the index and the asked-about epics, nothing else", () => {
  assert.deepEqual(heldEpics(null), []);
  const unstick = { "0:epic-decompose:21-t": { issue: 0, kind: "epic-decompose", tag: "21-t" } };
  assert.deepEqual(heldEpics({ epicStalls: [12, 21], unstick }).sort(), [12, 21]);
});

// #385: a release-gate the EM took is delivered, not a stall. The give-up stalls the old watch opened are closed on deploy.
test("a release gate taken by the EM is never given up on, and a handoff-gave-up stall open at deploy resolves", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[{"name":"pr approved"}]}]');
  const reason = releaseGateReason(["pr approved"], "[]");
  const old = iso(Date.now() - 48 * 3_600_000);
  // What the old build left: the gate taken, recalled to its cap, given up on, one open stall.
  await seed(w.rt, w.repo, 7, { unstick: { "7:release-gate": { issue: 7, kind: "release-gate", reason, status: "invoked", attempts: 4, recalls: 3, since: old, lastCallAt: old, gaveUpAt: old } } });
  await reportStall(w.rt, w.repo, { issue: 7, cause: "handoff-gave-up", eventAt: old, affected: ["o/host#7"], resolver: "owner-login", nextAction: "take release-gate: the EM handoff gave up", resumptionCondition: "x", evidence: "e" });
  await w.rt.records.updateRepoRecord(w.repo, (d) => { d.handoffStalls = [7]; });
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "open");
  assert.equal(await w.pass(1), 0, "no EM call on the unchanged reason");
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved", "the delivered handoff is not a stall");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined);
  const e = (await recordOf(w.rt, w.repo, 7)).unstick["7:release-gate"];
  assert.equal(e.status, "invoked", "the entry stands, so the card keeps its wait reason");
  for (let i = 2; i <= 5; i++) assert.equal(await w.pass(i), 0);
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved", "and no new stall opens");
});

test("a legacy escalated release gate (recalled, then given up on) resolves its stall on deploy; a never-delivered one keeps it", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[{"name":"pr approved"}]}]');
  const reason = releaseGateReason(["pr approved"], "[]");
  const old = iso(Date.now() - 48 * 3_600_000);
  const gaveUp = iso(Date.now() - 24 * 3_600_000);
  await seed(w.rt, w.repo, 7, { unstick: { "7:release-gate": { issue: 7, kind: "release-gate", reason, status: "escalated", attempts: 4, recalls: 3, since: old, lastCallAt: old, gaveUpAt: gaveUp } } });
  await reportStall(w.rt, w.repo, { issue: 7, cause: "handoff-gave-up", eventAt: gaveUp, affected: ["o/host#7"], resolver: "owner-login", nextAction: "take release-gate", resumptionCondition: "x", evidence: "e" });
  await w.rt.records.updateRepoRecord(w.repo, (d) => { d.handoffStalls = [7]; });
  assert.equal(await w.pass(1), 0, "no EM call on the unchanged reason");
  assert.equal((await w.stall(7, "handoff-gave-up")).state, "resolved");
  assert.equal((await repoRecordOf(w.rt, w.repo)).handoffStalls, undefined, "the index clears");
});

// --- Stage stalls: approved / prodVerifyHeld -> Foreman, awaitingRelease -> the escalation owner (stage-stalls.ts) ---
import { activeWorkSource } from "../dist/plugins/registry.js";
import { registerWorkSource } from "../dist/work-source.js";
import { planStageStalls } from "../dist/stage-stalls.js";

/** Runs `body` with the work source's snapshot answering `stages()` ({ issue: stage }), or throwing when it returns null. */
async function withStages(stages, body) {
  const real = activeWorkSource();
  registerWorkSource({ ...real, snapshot: async () => {
    const s = stages();
    if (s === null) throw new Error("source down");
    return Object.entries(s).map(([n, stage]) => ({ item: { issueNumber: Number(n), repo: "o/host" }, stage, detail: "" }));
  } });
  try { await body(); } finally { registerWorkSource(real); }
}

test("an approved card opens a Foreman-owned stage stall that keeps its start and resolves when the card moves", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  let stage = "approved";
  await withStages(() => ({ 7: stage }), async () => {
    await w.pass(1);
    const s = await w.stall(7, "stage-approved");
    assert.equal(s.state, "open");
    assert.equal(s.resolver, "Foreman");
    assert.deepEqual(s.affected, ["o/host#7"]);
    assert.deepEqual((await repoRecordOf(w.rt, w.repo)).stageStalls, [7]);
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-approved")).startedAt, s.startedAt, "a repeat never re-stamps the start");
    stage = "implementing";
    await w.pass(3);
    assert.equal((await w.stall(7, "stage-approved")).state, "resolved");
    assert.equal((await repoRecordOf(w.rt, w.repo)).stageStalls, undefined);
  });
});

test("prod verification held is the Foreman's; awaiting release is the escalation owner's; a move between them swaps the stall", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]},{"number":8,"title":"t","labels":[]}]');
  let s7 = "awaitingRelease";
  await withStages(() => ({ 7: s7, 8: "prodVerifyHeld" }), async () => {
    await w.pass(1);
    assert.equal((await w.stall(7, "stage-awaiting-release")).resolver, "owner-login");
    assert.equal((await w.stall(8, "stage-prod-verify-held")).resolver, "Foreman");
    s7 = "prodVerifyHeld";
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-awaiting-release")).state, "resolved");
    assert.equal((await w.stall(7, "stage-prod-verify-held")).state, "open");
    assert.deepEqual((await repoRecordOf(w.rt, w.repo)).stageStalls, [7, 8]);
  });
});

test("a stage stall on a card that closes resolves through the index, also after a restart", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  await withStages(() => ({ 7: "awaitingRelease" }), async () => {
    await w.pass(1);
    assert.equal((await w.stall(7, "stage-awaiting-release")).state, "open");
    writeFileSync(openFile, "[]");
    w.restart();
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-awaiting-release")).state, "resolved");
    assert.equal((await repoRecordOf(w.rt, w.repo)).stageStalls, undefined);
  });
});

test("stage stalls: flag off writes nothing, and an unreadable source touches nothing", async () => {
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  const off = world({ flag: false });
  await withStages(() => ({ 7: "approved" }), async () => { await off.pass(1); });
  assert.equal(await off.stall(7, "stage-approved"), undefined);
  const w = world();
  let up = true;
  await withStages(() => (up ? { 7: "approved" } : null), async () => {
    await w.pass(1);
    up = false;
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-approved")).state, "open", "a failed stage read resolves nothing");
    assert.deepEqual((await repoRecordOf(w.rt, w.repo)).stageStalls, [7]);
  });
});

test("planStageStalls keeps an unreadable indexed card and resolves a closed card's live stall only", () => {
  const live = { "stage-approved": { state: "open", cause: "stage-approved", affected: [] } };
  const done = { "stage-approved": { state: "resolved", cause: "stage-approved", affected: [] } };
  const plan = planStageStalls(new Map([[1, "approved"], [2, "merged"]]), new Map([[1, undefined], [2, live]]), new Map([[3, live], [4, done]]), [5], "o/host");
  assert.deepEqual(plan.report.map((r) => [r.issue, r.rule.cause]), [[1, "stage-approved"]]);
  assert.deepEqual(plan.resolve, [{ issue: 2, cause: "stage-approved" }, { issue: 3, cause: "stage-approved" }]);
  assert.deepEqual(plan.index, [1, 5]);
});

test("a card another stall already owns opens no stage stall, on its own record or named in a release stall's affected", () => {
  const release = { "release-sign-off": { state: "escalated", cause: "release-sign-off", affected: ["o/host#1", "o/host#2"] } };
  const plan = planStageStalls(new Map([[1, "awaitingSignoff"], [2, "awaitingSignoff"], [3, "releasing"], [4, "pendingVerification"]]),
    new Map([[1, release], [2, undefined], [3, undefined], [4, undefined]]), new Map(), [], "o/host");
  assert.deepEqual(plan.report.map((r) => [r.issue, r.rule.cause, r.rule.resolver]), [[3, "stage-releasing", "EM"], [4, "stage-pending-verification", "EM"]]);
  assert.deepEqual(plan.index, [3, 4]);
});

/** Ages issue 7's `cause` stall past the escalation bound, as if it opened 200 minutes ago. */
async function age(w, cause) {
  const r = await recordOf(w.rt, w.repo, 7);
  await seed(w.rt, w.repo, 7, { stalls: { ...r.stalls, [cause]: { ...r.stalls[cause], startedAt: APPROVED } } });
}
const stalledKeys = async (w) => Object.values((await recordOf(w.rt, w.repo, 7)).unstick ?? {}).filter((e) => e.kind === "stalled").length;

test("an escalated stage stall whose card moves is resolved, its question dropped, and the EM is not called about it again", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  let stage = "approved";
  await withStages(() => ({ 7: stage }), async () => {
    await w.pass(1);
    await age(w, "stage-approved");
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-approved")).state, "escalated");
    const delivered = w.stalledCalls(7, "stage-approved");
    assert.ok(delivered >= 1, "the escalation reached the EM");
    stage = "merged";
    await w.pass(3);
    await w.pass(4);
    assert.equal((await w.stall(7, "stage-approved")).state, "resolved");
    assert.equal(await stalledKeys(w), 0, "no stalled question stands or is recreated");
    assert.equal(w.stalledCalls(7, "stage-approved"), delivered, "no call about the resolved stall");
  });
});

test("a stage stall that ages past the bound in the same pass its card moves is never delivered", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  let stage = "approved";
  await withStages(() => ({ 7: stage }), async () => {
    await w.pass(1);
    await age(w, "stage-approved");
    stage = "merged";
    await w.pass(2);
    await w.pass(3);
    assert.equal((await w.stall(7, "stage-approved")).state, "resolved");
    assert.equal(await stalledKeys(w), 0);
    assert.equal(w.stalledCalls(7, "stage-approved"), 0);
  });
});

test("a closed card whose resolve cannot be saved stays in the stage-stall index and resolves once the save works", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":7,"title":"t","labels":[]}]');
  await withStages(() => ({ 7: "awaitingRelease" }), async () => {
    await w.pass(1);
    writeFileSync(openFile, "[]");
    const source = activeWorkSource();
    const save = source.saveRecord;
    breakRecords([7], { saves: true });
    await w.pass(2);
    assert.equal((await w.stall(7, "stage-awaiting-release")).state, "open");
    assert.deepEqual((await repoRecordOf(w.rt, w.repo)).stageStalls, [7], "the index keeps the unresolved card");
    source.saveRecord = save;
    await w.pass(3);
    assert.equal((await w.stall(7, "stage-awaiting-release")).state, "resolved");
    assert.equal((await repoRecordOf(w.rt, w.repo)).stageStalls, undefined);
  });
});

test("an approved card queued behind a build in the same repo opens no stall, and a live one resolves", () => {
  const live = { "stage-approved": { state: "open", cause: "stage-approved", affected: [] } };
  for (const busy of ["implementing", "inReview", "reviewing", "changesRequested", "revising"]) {
    const plan = planStageStalls(new Map([[1, "approved"], [2, "approved"], [3, busy]]), new Map([[1, undefined], [2, live], [3, undefined]]), new Map(), [], "o/host");
    assert.deepEqual(plan.report, [], `${busy}: a queued card is not reported`);
    assert.deepEqual(plan.resolve, [{ issue: 2, cause: "stage-approved" }], `${busy}: a live stall on a queued card resolves`);
  }
  const free = planStageStalls(new Map([[1, "approved"], [3, "merged"]]), new Map([[1, undefined], [3, undefined]]), new Map(), [], "o/host");
  assert.deepEqual(free.report.map((r) => [r.issue, r.rule.cause]), [[1, "stage-approved"]], "with the build free the stall opens");
  const held = planStageStalls(new Map([[1, "prodVerifyHeld"], [3, "inReview"]]), new Map([[1, undefined], [3, undefined]]), new Map(), [], "o/host");
  assert.deepEqual(held.report.map((r) => [r.issue, r.rule.cause]), [[1, "stage-prod-verify-held"]], "only approved cards queue");
});

// The board cannot show a build in flight: the card being built keeps `approved` until its PR is labelled (Tech Lead
// review of PR 441, R1-R4). The unstick pass reads the picker's own occupancy instead.
import { codeHost as realCodeHost, setCodeHost as setHost } from "../dist/plugins/registry.js";

async function withFeaturePr(pr, body) {
  const real = realCodeHost();
  setHost(new Proxy(real, { get: (t, k) => (k === "findOpenFeaturePR" ? async () => pr() : Reflect.get(t, k)) }));
  try { await body(); } finally { setHost(null); }
}

test("an approved card behind a build in flight (both cards still approved on the board) opens no stall; a live one resolves and its clock restarts once the build is free", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":1,"title":"t","labels":[]},{"number":3,"title":"t","labels":[]}]');
  await withFeaturePr(() => null, () => withStages(() => ({ 1: "approved", 3: "approved" }), async () => {
    await w.pass(1);
    const first = await w.stall(1, "stage-approved");
    assert.equal(first.state, "open", "build free: the clock runs");
    w.rt.builds.started(w.repo.name); // #3's implement session claims the build; the board still shows approved
    await w.pass(2);
    assert.equal((await w.stall(1, "stage-approved")).state, "resolved", "R2: a live stall on a queued card resolves");
    assert.equal((await w.stall(3, "stage-approved")).state, "resolved", "the card being built is not stalled either");
    await w.pass(3);
    assert.equal((await w.stall(1, "stage-approved")).state, "resolved", "R1: no stall reopens while the build is taken");
    w.rt.builds.ended(w.repo.name);
    await w.pass(4);
    const fresh = await w.stall(1, "stage-approved");
    assert.equal(fresh.state, "open", "R3: the build free, the clock starts again");
    assert.notEqual(fresh.startedAt, first.startedAt, "R3: a fresh clock, not the old start");
  }));
});

test("an open feature PR holds the build: approved cards behind it open no stall; a failed PR read is not occupancy", async () => {
  const w = world();
  writeFileSync(openFile, '[{"number":1,"title":"t","labels":[]}]');
  let pr = () => ({ number: 73, issueNumbers: [9] });
  await withFeaturePr(() => pr(), () => withStages(() => ({ 1: "approved" }), async () => {
    await w.pass(1);
    assert.equal(await w.stall(1, "stage-approved"), undefined, "queued behind PR #73");
    pr = () => { throw new Error("gh down"); };
    await w.pass(2);
    assert.equal((await w.stall(1, "stage-approved")).state, "open", "an unreadable PR still stalls");
    pr = () => null;
    await w.pass(3);
    assert.equal((await w.stall(1, "stage-approved")).state, "open", "no PR: the clock keeps running");
  }));
});
