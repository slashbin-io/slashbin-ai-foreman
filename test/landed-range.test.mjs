// Landed range (slashbin-ai-foreman#393): when the base branch moves, the Foreman asks the Tech Lead's `review-landed`
// about `landedHead..baseHead` once, records the head on a verdict, and hands REQUEST_CHANGES to the EM.
// Dark behind FOREMAN_LANDED_REVIEW. A fake `bin/tech-lead.mjs` plays the Tech Lead; the EM is never called (the
// hand-off outbox on the repo record is the only raise).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { reviewLandedRange, landedReviewEnabled, landedDedupeKey } from "../dist/phases/landed-range.js";
import { parseLandedTrailer, reviewLandedViaTechLead, TECH_LEAD_APPROVE_MAX_DURATION_MS } from "../dist/plugins/tech-lead.js";
import { startAgentPlugins } from "./agent-plugins.mjs";
import { EmHandoffs, HandoffNotSaved, UNSTICK_KINDS, UNSTICK_LIFECYCLES, EVENT_KINDS } from "../dist/unstick.js";

await startAgentPlugins();

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** A fake Tech Lead: logs its argv to `calls.jsonl`, prints `out` (`{from}`/`{to}` filled from its argv) and exits `code`. */
function fakeTechLead({ out = "TECHLEAD_LANDED from={from} to={to} verdict=COVERED", code = 0, sleepMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tl-landed-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "tech-lead.mjs"), `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(argv) + "\\n");
const at = (f) => argv[argv.indexOf(f) + 1];
const out = ${JSON.stringify(out)}.replace("{from}", at("--from")).replace("{to}", at("--to"));
const finish = () => { if (out) console.log(out); process.exit(${code}); };
${sleepMs ? `setTimeout(finish, ${sleepMs});` : "finish();"}
`);
  const calls = () => existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  return { dir, calls };
}

/** An in-memory record store: the repo record is subject 0. `unreadable` withholds it; `failWrites` refuses writes. */
function harness({ record = {}, unreadable = false, failWrites = false, failRaise = false } = {}) {
  const docs = new Map([[0, record]]);
  let reads = 0, writes = 0;
  const records = {
    async loadRepoRecord() { reads++; return unreadable ? null : docs.get(0); },
    async updateRepoRecord(_c, change) {
      writes++;
      if (failWrites) return false;
      const d = structuredClone(docs.get(0)); change(d); docs.set(0, d); return true;
    },
    async updateIssueRecord(_c, n, change) {
      const d = structuredClone(docs.get(n) ?? {}); change(d); docs.set(n, d); return true;
    },
  };
  const handoffs = new EmHandoffs(records);
  if (failRaise) handoffs.raise = async () => { throw new HandoffNotSaved("landed-changes-requested", "o/r"); };
  const rt = { handoffs, records };
  return {
    rt,
    record: () => docs.get(0),
    raised: () => Object.values(docs.get(0)?.unstick ?? {}),
    io: () => ({ reads, writes }),
  };
}

const repo = () => ({ ...loadConfig(), name: "r", githubRepo: "o/r", repoPath: "/nonexistent", baseBranch: "develop" });
const agent = (techLeadPath) => ({ ...loadConfig(), techLeadPath });

async function flag(on, fn) {
  const was = { F: process.env.FOREMAN_LANDED_REVIEW, K: process.env.TECHLEAD_GITHUB_KEY };
  if (on) process.env.FOREMAN_LANDED_REVIEW = "1"; else delete process.env.FOREMAN_LANDED_REVIEW;
  process.env.TECHLEAD_GITHUB_KEY = "test-key";
  try { return await fn(); } finally {
    if (was.F === undefined) delete process.env.FOREMAN_LANDED_REVIEW; else process.env.FOREMAN_LANDED_REVIEW = was.F;
    if (was.K === undefined) delete process.env.TECHLEAD_GITHUB_KEY; else process.env.TECHLEAD_GITHUB_KEY = was.K;
  }
}

const pass = (h, tl, head, events = []) => reviewLandedRange(h.rt, repo(), agent(tl.dir), head, quiet, events);

test("the kind is the EM's, a notice, and an event kind", () => {
  assert.ok(UNSTICK_KINDS.includes("landed-changes-requested"));
  assert.equal(UNSTICK_LIFECYCLES["landed-changes-requested"], "notice");
  assert.ok(EVENT_KINDS.has("landed-changes-requested"));
});

test("the dark flag: unset, empty and the off words are off", () => {
  for (const v of [undefined, "", "0", "false", "off", "no", " OFF "]) assert.equal(landedReviewEnabled(v === undefined ? {} : { FOREMAN_LANDED_REVIEW: v }), false, String(v));
  for (const v of ["1", "true", "on", "yes"]) assert.equal(landedReviewEnabled({ FOREMAN_LANDED_REVIEW: v }), true, v);
});

test("flag unset: no read, no call, no write", () => flag(false, async () => {
  const h = harness({ record: { landedHead: A } });
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, B), "skipped");
  assert.deepEqual(h.io(), { reads: 0, writes: 0 });
  assert.equal(tl.calls().length, 0);
}));

test("no reviewer role: nothing is read or written", () => flag(true, async () => {
  const h = harness();
  assert.equal(await reviewLandedRange(h.rt, repo(), agent(undefined), A, quiet, []), "skipped");
  assert.deepEqual(h.io(), { reads: 0, writes: 0 });
  assert.equal(h.record().landedHead, undefined);
}));

test("fetch failure (null baseHead): skipped, nothing read", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A } });
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, null), "skipped");
  assert.deepEqual(h.io(), { reads: 0, writes: 0 });
  assert.equal(tl.calls().length, 0);
}));

test("unreadable repo record: skipped, no call, no write", () => flag(true, async () => {
  const h = harness({ unreadable: true });
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, B), "skipped");
  assert.equal(h.io().writes, 0);
  assert.equal(tl.calls().length, 0);
}));

test("first pass records the head with no Tech Lead call (no backfill)", () => flag(true, async () => {
  const h = harness();
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, A), "baseline");
  assert.equal(h.record().landedHead, A);
  assert.equal(tl.calls().length, 0);
}));

test("an unchanged head makes no call and no write", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A } });
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, A), "unchanged");
  assert.equal(h.io().writes, 0);
  assert.equal(tl.calls().length, 0);
}));

test("the call carries --base and the full 40-char --from/--to", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A } });
  const tl = fakeTechLead();
  await pass(h, tl, B);
  assert.deepEqual(tl.calls(), [["review-landed", "--repo", "o/r", "--base", "develop", "--from", A, "--to", B]]);
}));

for (const verdict of ["COVERED", "APPROVE"]) {
  test(`${verdict}: the head is recorded, nothing raised, no event; the next pass is quiet`, () => flag(true, async () => {
    const h = harness({ record: { landedHead: A } });
    const tl = fakeTechLead({ out: `TECHLEAD_LANDED from={from} to={to} verdict=${verdict} posted=true` });
    const events = [];
    assert.equal(await pass(h, tl, B, events), "checked");
    assert.equal(h.record().landedHead, B);
    assert.deepEqual(h.raised(), []);
    assert.deepEqual(events, []);
    assert.equal(await pass(h, tl, B), "unchanged");
    assert.equal(tl.calls().length, 1);
  }));
}

test("REQUEST_CHANGES: one hand-off keyed by the range, then the head, then one warn event; none on the next pass", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A } });
  const tl = fakeTechLead({ out: "TECHLEAD_LANDED from={from} to={to} verdict=REQUEST_CHANGES posted=true" });
  const events = [];
  assert.equal(await pass(h, tl, B, events), "changes-requested");
  const raised = h.raised();
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "landed-changes-requested");
  assert.equal(raised[0].tag, landedDedupeKey(A, B));
  assert.equal(landedDedupeKey(A, B), `${A}..${B}`);
  assert.equal(h.record().landedHead, B);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, "warn");

  const again = [];
  assert.equal(await pass(h, tl, B, again), "unchanged");
  assert.equal(h.raised().length, 1);
  assert.deepEqual(again, []);
  assert.equal(tl.calls().length, 1);
}));

test("REQUEST_CHANGES whose hand-off is not saved: the head stays, and the next pass reviews the same range", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A }, failRaise: true });
  const tl = fakeTechLead({ out: "TECHLEAD_LANDED from={from} to={to} verdict=REQUEST_CHANGES" });
  const events = [];
  assert.equal(await pass(h, tl, B, events), "retry");
  assert.equal(h.record().landedHead, A);
  assert.deepEqual(events, []);
  await pass(h, tl, B);
  assert.deepEqual(tl.calls().map((c) => [c[6], c[8]]), [[A, B], [A, B]]);
}));

test("a verdict whose head cannot be recorded is a retry", () => flag(true, async () => {
  const h = harness({ record: { landedHead: A }, failWrites: true });
  const tl = fakeTechLead();
  assert.equal(await pass(h, tl, B), "retry");
  assert.equal(h.record().landedHead, A);
}));

for (const code of [1, 2, 3]) {
  test(`exit ${code}: the record is unchanged and the same range is asked again`, () => flag(true, async () => {
    const h = harness({ record: { landedHead: A } });
    const tl = fakeTechLead({ code });
    const events = [];
    assert.equal(await pass(h, tl, B, events), "retry");
    assert.equal(h.record().landedHead, A);
    assert.deepEqual(h.raised(), []);
    assert.deepEqual(events, []);
    assert.equal(await pass(h, tl, B), "retry");
    assert.deepEqual(tl.calls().map((c) => [c[6], c[8]]), [[A, B], [A, B]]);
  }));
}

test("a trailer for another range, or none, is a retry", () => flag(true, async () => {
  for (const out of [`TECHLEAD_LANDED from={from} to=${C} verdict=COVERED`, "TECHLEAD_LANDED verdict=COVERED", "done"]) {
    const h = harness({ record: { landedHead: A } });
    assert.equal(await pass(h, fakeTechLead({ out }), B), "retry");
    assert.equal(h.record().landedHead, A);
  }
}));

test("a timeout at the 20-minute bar is a retry", async () => {
  process.env.TECHLEAD_GITHUB_KEY ??= "test-key";
  assert.equal(TECH_LEAD_APPROVE_MAX_DURATION_MS, 20 * 60_000);
  const tl = fakeTechLead({ sleepMs: 60_000 });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = reviewLandedViaTechLead(repo(), agent(tl.dir), A, B, quiet);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(TECH_LEAD_APPROVE_MAX_DURATION_MS);
    const r = await run;
    assert.equal(r.kind, "retry");
    assert.match(r.reason, /timed out/);
  } finally {
    mock.timers.reset();
  }
});

test("missing Tech Lead config is a retry, never a verdict", async () => {
  assert.equal((await reviewLandedViaTechLead(repo(), agent(undefined), A, B, quiet)).kind, "retry");
});

test("parseLandedTrailer matches only this range and a known verdict", () => {
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A} to=${B} verdict=COVERED`, A, B), "COVERED");
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A} to=${B} verdict=APPROVE posted=false`, A, B), "APPROVE");
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A} to=${B} verdict=REQUEST_CHANGES posted=true`, A, B), "REQUEST_CHANGES");
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A} to=${C} verdict=COVERED`, A, B), null);
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A.slice(0, 7)} to=${B} verdict=COVERED`, A, B), null);
  assert.equal(parseLandedTrailer(`TECHLEAD_LANDED from=${A} to=${B} verdict=MAYBE`, A, B), null);
  assert.equal(parseLandedTrailer("", A, B), null);
});
