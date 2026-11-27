// An `unlinked-fix` question is withdrawn once its premise is gone: the holder is no longer the held verification, or the
// item no longer mentions it, or now corrects it (slashbin-ai-foreman#397). The stall it opened resolves with it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "./tmp-dir.mjs";
import { setStateDir } from "../dist/state-dir.js";
import { tryUnstick, resetDecomposeThrottle } from "../dist/phases/unstick.js";
import { unlinkedFixPremise } from "../dist/phases/implement.js";
import { dropIssueSnapshot } from "../dist/github/cache.js";
import { codeHost } from "../dist/plugins/registry.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { memoryRecords, recordOf } from "./issue-records.mjs";

const HOLDER = 5, ITEM = 7;
await startAgentPlugins();
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.EM_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_GITHUB_TOKEN ||= "test-token-not-real";
process.env.FOREMAN_STALL_CLOCK = "1";
const ghBin = mkTmp("unlinked-gh-");
const openFile = join(ghBin, "open.json");
const board = (holderMerged) => writeFileSync(openFile, JSON.stringify([
  { number: ITEM, title: "t", labels: [] },
  { number: HOLDER, title: "h", labels: [{ name: holderMerged ? "pr merged" : "release pending" }] },
]));
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(openFile)}\n`);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let relation = { corrects: [], mentions: [HOLDER] };
const host = codeHost();
const realRelations = host.relationsOf;
host.relationsOf = async () => new Map([[ITEM, relation]]);
test.after(() => { host.relationsOf = realRelations; });

async function world() {
  relation = { corrects: [], mentions: [HOLDER] };
  setStateDir(mkTmp("unlinked-state-"));
  memoryRecords();
  resetDecomposeThrottle();
  const em = mkTmp("unlinked-em-");
  mkdirSync(join(em, "bin"));
  const calls = join(em, "calls.log");
  writeFileSync(join(em, "bin/em.mjs"), `import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "unstick") { fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n"); process.exit(fs.existsSync(${JSON.stringify(join(em, "exit"))}) ? Number(fs.readFileSync(${JSON.stringify(join(em, "exit"))}, "utf8")) : 1); }
console.log("[]");`);
  const repo = { name: "host", githubRepo: "o/host", repoPath: em, lifecycleLabels: { prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod release" } };
  const config = { emRepoPath: em, sessionEnv: [], repos: [repo], unstickEscalationOwner: "owner-login", buildWaitsForDevVerify: true, backoff: { verifyRetry: { maxAttempts: 3 }, handoff: { baseMs: 1, capMs: 1, factor: 1, maxRecalls: 1 } } };
  const rt = new ForemanRuntime();
  assert.equal(await rt.handoffs.raise(repo, { kind: "unlinked-fix", subject: ITEM, dedupeKey: String(HOLDER), reason: "looks like the fix" }), true);
  return {
    rt, repo,
    held: (v) => board(v),
    exitWith: (code) => writeFileSync(join(em, "exit"), String(code)),
    pass: async (i) => { dropIssueSnapshot("o/host"); await sleep(5); resetDecomposeThrottle(); return tryUnstick(rt, repo, config, logger, i, { comment: () => {} }); },
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0),
    questions: async () => Object.keys((await recordOf(rt, repo, ITEM)).unstick ?? {}),
    stall: async () => (await recordOf(rt, repo, ITEM)).stalls?.["handoff-gave-up"],
  };
}

test("premise helper: false only when known false", () => {
  assert.equal(unlinkedFixPremise(5, 5, { corrects: [], mentions: [5] }), true);
  assert.equal(unlinkedFixPremise(5, null, { corrects: [], mentions: [5] }), false);
  assert.equal(unlinkedFixPremise(5, 6, undefined), false);
  assert.equal(unlinkedFixPremise(5, undefined, { corrects: [], mentions: [] }), false);
  assert.equal(unlinkedFixPremise(5, undefined, { corrects: [5], mentions: [5] }), false);
  assert.equal(unlinkedFixPremise(5, undefined, undefined), true, "nothing known keeps the question");
});

test("(a) the premise still holds: the question stands and the EM is asked", async () => {
  const w = await world();
  w.held(true);
  await w.pass(1);
  assert.deepEqual(await w.questions(), [`${ITEM}:unlinked-fix:${HOLDER}`]);
  assert.equal(w.calls(), 1);
});

test("(b) the holder is no longer the held verification: withdrawn, the EM is never called", async () => {
  const w = await world();
  w.held(false);
  await w.pass(1);
  assert.deepEqual(await w.questions(), []);
  assert.equal(w.calls(), 0);
});

test("(c) the item no longer mentions the holder, or now corrects it: withdrawn", async () => {
  for (const r of [{ corrects: [], mentions: [] }, { corrects: [HOLDER], mentions: [HOLDER] }]) {
    const w = await world();
    w.held(true);
    relation = r;
    await w.pass(1);
    assert.deepEqual(await w.questions(), []);
    assert.equal(w.calls(), 0);
  }
});

test("(d) a handoff-gave-up stall on a withdrawn question resolves", async () => {
  const w = await world();
  w.held(true);
  for (let i = 1; i <= 3; i++) await w.pass(i);
  assert.equal((await w.stall()).state, "open");
  const before = w.calls();
  w.held(false);
  await w.pass(4);
  assert.equal((await w.stall()).state, "resolved");
  assert.equal(w.calls(), before, "no further EM call");
});

test("(e) premise still true: an EM decline after a prior handoff is final, and its stall resolves", async () => {
  const w = await world();
  w.held(true);
  w.exitWith(0);
  await w.pass(1); // handed off
  w.exitWith(3);
  await w.pass(2); // recalled, declined: "not the fix"
  const before = w.calls();
  await w.pass(3);
  await w.pass(4);
  assert.equal(w.calls(), before, "no further EM call");
  assert.equal((await w.stall()), undefined, "no give-up stall opens");
});
