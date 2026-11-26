// The builder preflight gate (QA's `preflight --local` before review) and the QA plugin's preflight runner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflightGate, preflightComment, PREFLIGHT_MAX_FIX_ROUNDS, PREFLIGHT_HEADING } from "../dist/phases/preflight-gate.js";
import { QaPlugin } from "../dist/plugins/qa.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

const make = ({ covers = true, outs, fixOk = true, sha = "abcdef123456" } = {}) => {
  const rec = { runs: [], fixes: [], comments: [], logs: [] };
  const q = [...outs];
  return {
    rec,
    deps: {
      covers: async () => covers,
      headSha: async () => sha,
      run: async (s, round) => { rec.runs.push([s, round]); return q.shift() ?? { kind: "clean", summary: "" }; },
      fix: async (f) => { rec.fixes.push(f); return fixOk; },
      comment: async (b) => { rec.comments.push(b); },
      log: (m) => rec.logs.push(m),
    },
  };
};
const F = (t = "FINDING page-overflow /x phone: 396px in 390px") => ({ kind: "findings", summary: t });
const C = { kind: "clean", summary: "" };

test("not covered or unknown: nothing runs", async () => {
  for (const covers of [false, "unknown"]) {
    const { rec, deps } = make({ covers, outs: [F()] });
    assert.equal((await runPreflightGate(deps)).status, "not-covered");
    assert.equal(rec.runs.length, 0);
  }
});

test("clean first run: silent, no fix session", async () => {
  const { rec, deps } = make({ outs: [C] });
  assert.deepEqual(await runPreflightGate(deps), { status: "clean", rounds: 0 });
  assert.equal(rec.fixes.length, 0);
  assert.equal(rec.comments.length, 0);
});

test("findings are handed to a fix session, the rerun is clean: fixed, said on the PR", async () => {
  const { rec, deps } = make({ outs: [F("A"), C] });
  assert.deepEqual(await runPreflightGate(deps), { status: "fixed", rounds: 1 });
  assert.deepEqual(rec.fixes, ["A"]);
  assert.equal(rec.runs.length, 2);
  assert.match(rec.comments[0], new RegExp(PREFLIGHT_HEADING));
  assert.match(rec.comments[0], /fixed them in 1 round/);
});

test("findings that persist stop at the round cap and are said on the PR; the gate never throws or blocks", async () => {
  const { rec, deps } = make({ outs: [F("1"), F("2"), F("3"), F("4")] });
  const r = await runPreflightGate(deps);
  assert.deepEqual(r, { status: "unresolved", rounds: PREFLIGHT_MAX_FIX_ROUNDS });
  assert.equal(rec.fixes.length, PREFLIGHT_MAX_FIX_ROUNDS);
  assert.equal(rec.runs.length, PREFLIGHT_MAX_FIX_ROUNDS + 1);
  assert.match(rec.comments[0], /Findings remain/);
  assert.match(rec.comments[0], /3/);
});

test("a fix session that pushed nothing ends the loop as unresolved", async () => {
  const { rec, deps } = make({ outs: [F("A"), F("A")], fixOk: false });
  assert.equal((await runPreflightGate(deps)).status, "unresolved");
  assert.equal(rec.runs.length, 1);
  assert.equal(rec.comments.length, 1);
});

test("could-not-run (exit 3) does not block: logged on the PR, no fix session", async () => {
  const { rec, deps } = make({ outs: [{ kind: "could-not-run", summary: "local-boot-failed: npm ci failed\nmore" }] });
  assert.equal((await runPreflightGate(deps)).status, "could-not-run");
  assert.equal(rec.fixes.length, 0);
  assert.match(rec.comments[0], /Could not run/);
  assert.match(rec.comments[0], /does not block/);
  assert.doesNotMatch(rec.comments[0], /more/);
});

test("an unreadable head or a throwing edge is could-not-run, never a throw", async () => {
  const a = make({ outs: [] }); a.deps.headSha = async () => null;
  assert.equal((await runPreflightGate(a.deps)).status, "could-not-run");
  const b = make({ outs: [] }); b.deps.run = async () => { throw new Error("boom"); };
  assert.equal((await runPreflightGate(b.deps)).status, "could-not-run");
  assert.ok(b.rec.logs.some((l) => /boom/.test(l)));
});

test("a runner with no preflight is not-covered", async () => {
  const { deps } = make({ outs: [] });
  deps.run = async () => null;
  assert.equal((await runPreflightGate(deps)).status, "not-covered");
});

test("the comment names the head sha", () => {
  assert.match(preflightComment("unresolved", 2, "x", "0123456789"), /01234567/);
});

// --- the QA plugin's preflight: exit codes map to outcomes, argv is the safe local form ---
const tmp = mkdtempSync(join(tmpdir(), "preflight-"));
const em = join(tmp, "em"), qa = join(tmp, "qa"), out = join(tmp, "out");
for (const d of [em, qa, out]) mkdirSync(d);
const calls = join(tmp, "calls.jsonl"), mode = join(tmp, "mode.json");
writeFileSync(calls, "");
writeFileSync(join(em, "runner.mjs"), `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const m = JSON.parse(readFileSync(${JSON.stringify(mode)}, "utf8"));
if (m.say) console.log(m.say);
process.exit(m.code);
`);
const config = { qaPath: qa, emRepoPath: em, qaSecretsRunner: "runner.mjs", qaRepos: ["o/docs"], sessionEnv: [], pollIntervalMs: 1500, qaBearerKey: "BEARER@home" };
const plugin = new QaPlugin();
const pf = (c = config) => plugin.qa.preflight({ githubRepo: "o/docs" }, c, { repo: "o/docs", ref: "abc123", out }, quiet);

test("plugin preflight: exit 0 clean, 1 findings with the text, 3 could-not-run", async () => {
  writeFileSync(mode, JSON.stringify({ code: 0, say: "QA preflight CLEAN" }));
  assert.deepEqual(await pf(), { kind: "clean", summary: "QA preflight CLEAN" });
  writeFileSync(mode, JSON.stringify({ code: 1, say: "FINDING page-overflow /x phone" }));
  assert.deepEqual(await pf(), { kind: "findings", summary: "FINDING page-overflow /x phone" });
  writeFileSync(mode, JSON.stringify({ code: 3, say: "QA preflight COULD-NOT-RUN" }));
  assert.equal((await pf()).kind, "could-not-run");
  writeFileSync(mode, JSON.stringify({ code: 9 }));
  assert.equal((await pf()).kind, "could-not-run");
});

test("plugin preflight: argv is `preflight --local` with the ref, no PR, and the bearer only", async () => {
  writeFileSync(mode, JSON.stringify({ code: 0 }));
  await pf();
  const last = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).pop();
  const i = last.indexOf("preflight");
  assert.deepEqual(last.slice(i, i + 7), ["preflight", "--local", "--repo", "o/docs", "--ref", "abc123", "--out"]);
  assert.ok(!last.includes("--pr"));
  assert.deepEqual(last[last.indexOf("--keys") + 1].split(","), ["BEARER@home"]);
});

test("plugin preflight: a missing runner is could-not-run, never a throw", async () => {
  assert.equal((await pf({ ...config, qaSecretsRunner: undefined })).kind, "could-not-run");
});
