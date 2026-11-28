// Review intake (src/review-intake.ts): the Foreman offers each open PR head of a `review-only` repo to the Tech
// Lead once, and writes no status itself. Cases (a) to (g) run against fake registry, code host and reviewer;
// nothing reaches GitHub, the registry or the Tech Lead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReviewIntake, needsReview, REVIEW_STATUS_CONTEXT } from "../dist/review-intake.js";
import { ForemanRuntime } from "../dist/runtime.js";
import { createRepoIdentity } from "../dist/paperclip/repo-identity.js";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-11-27T12:00:00Z");
const MAX = 3_600_000;
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const repo = { name: "svc", githubRepo: "o/svc", repoPath: "/nowhere", baseBranch: "main", syncOnly: true };
const config = { reviewMaxDurationMs: MAX };
const ago = (ms) => new Date(NOW - ms).toISOString();

/** Fakes that record every call; `status` is what the head's `techlead/review` status reads. */
function fakes({ mode = "review-only", registryDown = false, status = null, required = true } = {}) {
  const calls = { offered: [], statusReads: [], writes: 0 };
  const ledger = new Map();
  return {
    calls,
    deps: {
      async processMode() { if (registryDown) throw new Error("registry unreachable"); return mode; },
      host: {
        async listOpenPrHeads() { return [{ number: 7, sha: SHA }]; },
        async readHeadStatus(_c, sha, context) { calls.statusReads.push([sha, context]); return status; },
        async requiresStatusCheck() { return required; },
      },
      async reviewHead(_r, pr, sha) { calls.offered.push([pr, sha]); return { kind: "done" }; },
      now: () => NOW,
      async admit(_r, pr, sha) {
        const k = `${pr}@${sha}`;
        const n = ledger.get(k) ?? 0;
        if (n >= 3) return { status: "held", count: n, first: n === 3, since: "" };
        ledger.set(k, n + 1);
        return { status: "admitted", count: n + 1 };
      },
      async refund(_r, pr, sha) { const k = `${pr}@${sha}`; ledger.set(k, (ledger.get(k) ?? 1) - 1); },
    },
  };
}
const run = (f, events) => runReviewIntake(new ForemanRuntime(), repo, config, logger, events, f.deps);

test("(a) an open head with no status is offered once: exact review-pr arguments, nothing written", async () => {
  const f = fakes();
  assert.equal(await run(f), true);
  assert.deepEqual(f.calls.offered, [[7, SHA]]);
  assert.deepEqual(f.calls.statusReads, [[SHA, REVIEW_STATUS_CONTEXT]]);
  assert.equal(f.calls.writes, 0);
});

test("(a) the plugin passes --sha and --no-merge to review-pr", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/plugins/tech-lead.ts", import.meta.url), "utf8");
  assert.match(src, /\["review-pr", "--repo", repoConfig\.githubRepo, "--pr", String\(prNumber\), "--sha", sha, "--no-merge"\]/);
});

test("(b) a success status, or a young pending one, takes no action", async () => {
  for (const status of [{ state: "success", description: "ok", updatedAt: ago(10 * MAX) }, { state: "pending", description: "", updatedAt: ago(1000) }]) {
    const f = fakes({ status });
    assert.equal(await run(f), false);
    assert.deepEqual(f.calls.offered, []);
  }
});

test("(c) a pending status older than reviewMaxDurationMs is offered again", async () => {
  const f = fakes({ status: { state: "pending", description: "", updatedAt: ago(MAX + 1000) } });
  assert.equal(await run(f), true);
  assert.deepEqual(f.calls.offered, [[7, SHA]]);
});

test("(d) a REQUEST_CHANGES failure is not offered again", async () => {
  const f = fakes({ status: { state: "failure", description: "REQUEST_CHANGES: 2 S2 findings", updatedAt: ago(1000) } });
  assert.equal(await run(f), false);
  assert.deepEqual(f.calls.offered, []);
});

test("(e) an incomplete-review failure is offered again, at most MAX_REVIEW_ATTEMPTS_PER_HEAD times", async () => {
  const f = fakes({ status: { state: "failure", description: "review timed out", updatedAt: ago(1000) } });
  const rt = new ForemanRuntime();
  for (let i = 0; i < 5; i++) await runReviewIntake(rt, repo, config, logger, [], f.deps);
  assert.equal(f.calls.offered.length, 3);
  // The ledger is the PR record, not process memory: a restarted Foreman (a new runtime) gets no fresh attempts.
  await runReviewIntake(new ForemanRuntime(), repo, config, logger, [], f.deps);
  assert.equal(f.calls.offered.length, 3);
});

test("(f) an unreachable registry skips the repo and writes nothing", async () => {
  const f = fakes({ registryDown: true });
  assert.equal(await run(f), false);
  assert.deepEqual(f.calls.offered, []);
  assert.deepEqual(f.calls.statusReads, []);
});

test("(g) a repo whose processMode is not review-only (or is null) is untouched", async () => {
  for (const mode of ["full", "none", null]) {
    const f = fakes({ mode });
    assert.equal(await run(f), false);
    assert.deepEqual(f.calls.statusReads, []);
    assert.deepEqual(f.calls.offered, []);
  }
});

test("a reviewer that wrote nothing (retry) is not charged an attempt", async () => {
  const f = fakes();
  f.deps.reviewHead = async () => { f.calls.offered.push("x"); return { kind: "retry", reason: "codex signed out" }; };
  const rt = new ForemanRuntime();
  for (let i = 0; i < 5; i++) await runReviewIntake(rt, repo, config, logger, [], f.deps);
  assert.equal(f.calls.offered.length, 5);
});

test("ruleset drift: no ruleset requiring the status posts one notice per repo, and the review still starts", async () => {
  const f = fakes({ required: false });
  const rt = new ForemanRuntime();
  const events = [];
  await runReviewIntake(rt, repo, config, logger, events, f.deps);
  await runReviewIntake(rt, repo, config, logger, events, f.deps);
  assert.equal(events.filter((e) => /no active ruleset requires/.test(e.message)).length, 1);
  assert.ok(rt.memory.observerEventsSent.has("ruleset-drift:o/svc"), "observers were told once through the notice path");
  assert.equal(f.calls.offered.length, 2);
});

test("an attempt that cannot be recorded means no review this pass", async () => {
  const f = fakes();
  f.deps.admit = async () => ({ status: "unavailable" });
  assert.equal(await run(f), false);
  assert.deepEqual(f.calls.offered, []);
});

test("the GitHub reads follow every page: heads past 200 PRs, a verdict behind 30 newer statuses", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/github/review-intake-reads.ts", import.meta.url), "utf8");
  assert.equal((src.match(/"--paginate"/g) ?? []).length, 2, "both the PR list and the status list are paginated");
  assert.doesNotMatch(src, /--limit/);
});

test("the registry reader is installed by loading the paperclip module, with no plugin started", async () => {
  await import("../dist/plugins/paperclip.js");
  const { repoProcessMode } = await import("../dist/plugins/registry.js");
  await assert.rejects(repoProcessMode({ paperclip: {} }, "o/svc"), /no registry configured/);
});

test("needsReview: no status, young pending, success, verdict and incomplete failures", () => {
  assert.equal(needsReview(null, NOW, MAX), true);
  assert.equal(needsReview({ state: "success", description: "not applicable: sync", updatedAt: ago(0) }, NOW, MAX), false);
  assert.equal(needsReview({ state: "failure", description: "Request changes", updatedAt: ago(0) }, NOW, MAX), false);
  assert.equal(needsReview({ state: "failure", description: "could not read the diff", updatedAt: ago(0) }, NOW, MAX), true);
});

test("the registry policy read asks service_detail with an explicit artifact_path: null and never caches", async () => {
  const sent = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== "tools/call") return new Response("{}", { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" } });
    sent.push(body.params);
    const answer = body.params.arguments.repo === "o/none" ? { error: "no whole-repo policy row" } : { service: { delivery: { processMode: "review-only", reviewRequired: true } } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: answer } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const id = createRepoIdentity({ url: "http://registry.invalid/mcp", fetch });
  assert.deepEqual(await id.policyOf("o/svc"), { processMode: "review-only", reviewRequired: true });
  await id.policyOf("o/svc");
  assert.equal(sent.length, 2, "asked again each time");
  assert.equal(sent[0].name, "service_detail");
  assert.ok("artifact_path" in sent[0].arguments && sent[0].arguments.artifact_path === null);
  await assert.rejects(id.policyOf("o/none"), /no whole-repo policy row/);
});
