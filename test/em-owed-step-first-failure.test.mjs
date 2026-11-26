// A prod acceptance that fails on a card naming an EM-owned step files the EM's follow-up on the FIRST failure,
// not after the 7-day hold age (slashbin-engineering-manager rule-origins 2026-11-26, slashbin_mcp_services#775).
import test from "node:test";
import assert from "node:assert/strict";
import { notifyEmOwedStep, EM_OWED_STEP } from "../dist/phases/release.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { githubRepo: "o/r", epicRefLabel: "Epic" };
const cfg = { unstickEscalationOwner: "xrgarcia" };
const held = { pr: 9, issues: [5, 6], phase: "held", hold: "acceptance-failed", originatedAt: "2026-11-26T20:12:00Z", evidence: "see https://example.test/ev." };

test("EM_OWED_STEP matches the marker only", () => {
  assert.ok(EM_OWED_STEP.test("Post-deploy: EM-owned step, publish the policy doc"));
  assert.ok(!EM_OWED_STEP.test("an ordinary card"));
});

test("files once per card that names an EM-owned step, with outcome failed", async () => {
  const calls = [];
  const plugin = { fileVerifyFollowUp: async (_r, _c, input) => { calls.push(input); return { kind: "filed", issue: 1, url: "u" }; } };
  const bodies = { 5: "Acceptance\nEM-owned: publish the doc", 6: "nothing here" };
  await notifyEmOwedStep(repo, cfg, held, [5, 6], logger, async (n) => bodies[n], plugin);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].card, 5);
  assert.equal(calls[0].outcome, "failed");
  assert.equal(calls[0].reason, "acceptance-failed");
  assert.equal(calls[0].owner, "xrgarcia");
});

test("a failed filing or an unreadable card never throws; no plugin does nothing", async () => {
  const plugin = { fileVerifyFollowUp: async () => ({ kind: "failed", detail: "x" }) };
  await notifyEmOwedStep(repo, cfg, held, [5], logger, async () => "EM-owned", plugin);
  await notifyEmOwedStep(repo, cfg, held, [5], logger, async () => { throw new Error("gh"); }, plugin);
  await notifyEmOwedStep(repo, cfg, held, [5], logger, async () => "EM-owned", undefined);
});
