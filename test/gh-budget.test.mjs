// 2026-11-28: idle polling spent 4,968 of 5,000 GraphQL points an hour. The guard slows idle polls below a reserve;
// the memo makes callers in one pass share one read.
import test from "node:test";
import assert from "node:assert/strict";
import { pollSlowdown, BudgetGuard, setBudgetReader, DEFAULT_BUDGET } from "../dist/gh-budget.js";
import { configureReadMemo, clearReadMemo, memoRead } from "../dist/read-memo.js";

const b = (remaining, limit = 5000) => ({ remaining, limit });
const logger = () => {
  const lines = [];
  return { lines, debug() {}, info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]), error() {}, child() { return this; } };
};

test("polling is not slowed while both buckets hold the reserve", () => {
  assert.equal(pollSlowdown({ graphql: b(5000), core: b(5000) }), 1);
  assert.equal(pollSlowdown({ graphql: b(2000), core: b(4000) }), 1, "exactly 40% left is the reserve");
  assert.equal(pollSlowdown({}), 1, "an unreadable quota never slows");
});

test("polling slows below the reserve, by the scarcer bucket, up to the cap", () => {
  assert.equal(pollSlowdown({ graphql: b(1000), core: b(5000) }), 2, "20% left");
  assert.equal(pollSlowdown({ graphql: b(5000), core: b(1000) }), 2, "core counts too");
  assert.equal(pollSlowdown({ graphql: b(0) }), DEFAULT_BUDGET.maxFactor);
  assert.equal(pollSlowdown({ graphql: b(32) }), DEFAULT_BUDGET.maxFactor, "the cap holds near empty");
});

test("the guard reads the quota once per refresh window and logs the crossing once", async () => {
  let reads = 0;
  let remaining = 4000;
  setBudgetReader(async () => { reads++; return { graphql: b(remaining), core: b(5000) }; });
  let t = 1_000_000;
  const log = logger();
  const g = new BudgetGuard(log, DEFAULT_BUDGET, () => t);
  assert.equal(await g.factor(), 1);
  assert.equal(await g.factor(), 1);
  assert.equal(reads, 1, "two asks in one window read once");
  remaining = 500;
  t += 61_000;
  assert.equal(await g.factor(), 4, "10% left");
  assert.equal(await g.factor(), 4);
  assert.equal(reads, 2);
  assert.equal(log.lines.filter(([l]) => l === "warn").length, 1, "one warning, not one per lane");
  remaining = 4500;
  t += 61_000;
  assert.equal(await g.factor(), 1);
  assert.equal(log.lines.filter(([l]) => l === "info").length, 1, "recovery is logged");
  setBudgetReader(undefined);
});

test("a failing quota read keeps the last answer and never throws", async () => {
  setBudgetReader(async () => { throw new Error("gh down"); });
  const g = new BudgetGuard(logger());
  assert.equal(await g.factor(), 1);
  setBudgetReader(undefined);
});

test("memoRead is off by default, shares one read inside the window, and drops failures", async () => {
  let n = 0;
  const read = async () => ++n;
  configureReadMemo(0);
  await memoRead("k", read);
  await memoRead("k", read);
  assert.equal(n, 2, "off: every caller reads");

  configureReadMemo(30_000);
  n = 0;
  const [a, c] = await Promise.all([memoRead("k", read), memoRead("k", read)]);
  assert.equal(n, 1);
  assert.equal(a, c, "concurrent callers share the in-flight read");
  await memoRead("k", read);
  assert.equal(n, 1, "a repeat inside the window is served");
  await memoRead("other", read);
  assert.equal(n, 2);

  clearReadMemo();
  await memoRead("k", read);
  assert.equal(n, 3, "a write clears it");

  let fails = 0;
  const bad = async () => { fails++; throw new Error("x"); };
  await assert.rejects(memoRead("bad", bad));
  await assert.rejects(memoRead("bad", bad));
  assert.equal(fails, 2, "a failure is never kept");
  configureReadMemo(0);
});

test("a gh write clears the memo, a gh read does not", async () => {
  const { invalidateSnapshotIfMutating } = await import("../dist/github/cache.js");
  configureReadMemo(30_000);
  let n = 0;
  const read = async () => ++n;
  await memoRead("k", read);
  invalidateSnapshotIfMutating(["pr", "view", "5", "--json", "state"]);
  invalidateSnapshotIfMutating(["api", "repos/o/r/issues/5"]);
  await memoRead("k", read);
  assert.equal(n, 1, "reads leave it");
  invalidateSnapshotIfMutating(["api", "-X", "PUT", "repos/o/r/pulls/5/update-branch"]);
  await memoRead("k", read);
  assert.equal(n, 2, "a write clears it");
  configureReadMemo(0);
});
