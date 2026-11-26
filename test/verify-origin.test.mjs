// A verify hold records when it first began (`originatedAt`) once, and every rewrite copies it. `heldAt` keeps
// resetting: it is the basis of the release facts. A record from before the field existed is backfilled from its own heldAt.
import test from "node:test";
import assert from "node:assert/strict";
import { registerPlugin, startPlugins, setCodeHost, resetRegistryForTests } from "../dist/plugins/registry.js";
import { registerWorkSource } from "../dist/work-source.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { DEFAULT_BACKOFF } from "../dist/backoff.js";
import { tryVerify } from "../dist/phases/verify.js";
import { holdOrigin } from "../dist/issue-records.js";
import { seed, recordOf } from "./issue-records.mjs";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const REPO = {
  name: "r", githubRepo: "o/r", repoPath: "/nonexistent", baseBranch: "develop", productionBranch: "main", featureBranch: "develop",
  lifecycleLabels: { prUnderReview: "pr under review", prPendingActions: "pr pending actions", prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod release", releasePending: "release pending", prodVerifyHeld: "prod verification held", readyToClose: "ready to close" },
  github: { blockedLabel: "blocked" },
};
const CONFIG = { qaRepos: [], stages: [], paperclip: { enabled: false }, backoff: DEFAULT_BACKOFF, qaGate: false };
const LONG_AGO = "2026-01-01T00:00:00.000Z";
const LONG_AGO_S = "2026-01-01T00:00:00Z";
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** One verify pass over issue 224 (PR 225) whose verifier returns `verdict`; `prior` seeds the hold (undefined: none). */
async function pass({ prior, verdict, merged = true }) {
  resetRegistryForTests();
  const rt = new ForemanRuntime();
  const store = new InMemoryRecordStore();
  registerWorkSource({
    record: async () => true,
    loadRecord: (k, rc) => store.loadRecord(k, rc),
    saveRecord: (k, r, rc) => store.saveRecord(k, r, rc),
  });
  registerPlugin({
    id: "fake-sre", roles: ["verifier"], enabled: () => true, fills: (role) => role === "verifier",
    verifier: { verifyDev: async () => verdict },
  });
  await startPlugins(CONFIG, { logger, configText: () => null });
  setCodeHost(new Proxy({}, { get: (_, k) => {
    if (k === "then" || typeof k === "symbol") return undefined;
    const impl = {
      findIssuesAwaitingVerify: async () => [224],
      getOpenIssues: async () => [{ number: 224 }],
      findIssuesMergedToBase: async () => (merged ? [{ issueNumber: 224, prNumber: 225, prUrl: "", mergedAt: "2026-01-01T00:00:00Z" }] : []),
      issueLastEditedAt: async () => null,
      viewReleasePr: async () => ({ number: 225, mergeSha: "45fb3042c2efac9214bff2ffa42eab88020f4ef3" }),
      issueCommentRows: async () => [],
      deploymentsForSha: async () => [],
      prFilesTouched: async () => [],
      forgetOpenPrs: () => {},
    }[k];
    return impl ?? (async () => { throw new Error(`unexpected code host call: ${String(k)}`); });
  } }));
  await seed(rt, REPO, 224, prior ? { verifyHeld: prior } : {});
  const before = Date.now();
  await tryVerify(rt, REPO, CONFIG, logger, 1);
  const held = (await recordOf(rt, REPO, 224)).verifyHeld?.[224] ?? (await recordOf(rt, REPO, 224)).verifyHeld;
  resetRegistryForTests();
  registerWorkSource(null);
  setCodeHost(null);
  return { held, before };
}

const failed = { kind: "verdict", pass: false, reason: "dev-verify-failed", trailer: { deploy: "FAILURE" }, summary: "red" };

test("holdOrigin: the prior origin, else the prior heldAt, else now", () => {
  assert.equal(holdOrigin({ heldAt: "b", originatedAt: "a" }, "now"), "a");
  assert.equal(holdOrigin({ heldAt: "b" }, "now"), "b", "a legacy record takes its own heldAt, never now");
  assert.equal(holdOrigin(undefined, "now"), "now");
  assert.equal(holdOrigin(undefined, "2026-01-01T00:00:00.123Z"), "2026-01-01T00:00:00Z", "whole seconds");
});

test("a first hold sets originatedAt to the time of the write, in UTC", async () => {
  const { held, before } = await pass({ verdict: failed });
  assert.match(held.originatedAt, ISO_Z);
  assert.equal(held.originatedAt, held.heldAt.replace(/\.\d+Z$/, "Z"), "first write: the same instant, whole seconds");
  assert.ok(Date.parse(held.originatedAt) >= before - 1000);
});

test("a retry that fails again keeps originatedAt while heldAt advances", async () => {
  const { held } = await pass({ verdict: failed, prior: { heldAt: LONG_AGO, originatedAt: "2025-12-01T00:00:00Z", prNumber: 225, reason: "dev-verify-failed", attempts: 1 } });
  assert.equal(held.originatedAt, "2025-12-01T00:00:00Z");
  assert.ok(Date.parse(held.heldAt) > Date.parse(LONG_AGO), "heldAt still resets");
  assert.equal(held.attempts, 2);
});

test("the exhausted rewrite keeps originatedAt", async () => {
  const { held } = await pass({ verdict: failed, prior: { heldAt: LONG_AGO, originatedAt: "2025-12-01T00:00:00Z", prNumber: 225, reason: "dev-verify-failed", attempts: 2 } });
  assert.equal(held.attempts, 3);
  assert.equal(held.originatedAt, "2025-12-01T00:00:00Z");
});

test("a legacy hold with only heldAt is backfilled from heldAt, never from now", async () => {
  const { held } = await pass({ verdict: failed, prior: { heldAt: LONG_AGO, prNumber: 225, reason: "dev-verify-failed", attempts: 1 } });
  assert.equal(held.originatedAt, LONG_AGO_S);
  assert.notEqual(held.heldAt, LONG_AGO);
});

test("a wait-until hold keeps originatedAt across the rewrite", async () => {
  const wait = { kind: "verdict", pass: false, reason: "wait-until-20990101T0000Z", trailer: {}, summary: "later" };
  const { held } = await pass({ verdict: wait, prior: { heldAt: LONG_AGO, originatedAt: "2025-12-01T00:00:00Z", prNumber: 225, reason: "dev-verify-failed", attempts: 1 } });
  assert.equal(held.originatedAt, "2025-12-01T00:00:00Z");
});

test("a PR-less hold (no merged PR closes the issue) sets originatedAt", async () => {
  const { held } = await pass({ verdict: failed, merged: false });
  assert.equal(held.reason, "no-merged-pr");
  assert.match(held.originatedAt, ISO_Z);
});

test("a released then new hold gets a new originatedAt", async () => {
  const pass1 = await pass({ verdict: { kind: "verdict", pass: true, trailer: { deploy: "SUCCESS" }, summary: "" }, prior: { heldAt: LONG_AGO, originatedAt: "2025-12-01T00:00:00Z", prNumber: 225, reason: "dev-verify-failed", attempts: 1 } });
  assert.equal(pass1.held, undefined, "a pass releases the hold, so its origin goes with it");
  const next = await pass({ verdict: failed });
  assert.ok(Date.parse(next.held.originatedAt) > Date.parse("2026-11-01T00:00:00Z"));
});
