// The Tech Lead hand-off (EM#427). Run with `npm test` after `npm run build`.
//
// The contract under test is the one that keeps reviews from ever waiting on
// Codex: exit 3 means "wrote nothing" and MUST come back as a fallback so the
// Claude review runs; any other failure must NOT, because it may have written.
import test from "node:test";
import { mkTmp } from "./tmp-dir.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewViaTechLead, isEmptyPostResponseError } from "../dist/plugins/tech-lead.js";

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const repo = { name: "r", githubRepo: "o/r" };

function fakeTechLead(script) {
  const dir = mkTmp("fake-tech-lead-");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/tech-lead.mjs"), script);
  return { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
}

process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";

test("exit 3 (wrote nothing) falls back to the Claude review", async () => {
  const cfg = fakeTechLead('console.log("Codex first read failed (signed-out) — nothing written"); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /signed-out/);
});

test("a trailer from the Tech Lead is parsed exactly like the Claude review's", async () => {
  const cfg = fakeTechLead('console.log("APPROVED and merged"); console.log("FOREMAN_REVIEW pr=#5 verdict=APPROVE merged=yes deploy=SUCCESS");');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.success, true);
  assert.equal(r.trailers.length, 1);
  assert.equal(r.trailers[0].merged, true);
});

test("any other failure is a failure, NOT a fallback — it may have written", async () => {
  const cfg = fakeTechLead('console.error("boom after posting"); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal("fallback" in r, false);
  assert.equal(r.success, false);
});

test("exit 0 with no trailer is a failure, as on the Claude path", async () => {
  const cfg = fakeTechLead('console.log("done, I think");');
  const r = await reviewViaTechLead(repo, cfg, 5, logger);
  assert.equal(r.success, false);
  assert.match(r.error, /without a FOREMAN_REVIEW trailer/);
});

test("unset techLeadPath is a fallback, so the default config is unchanged", async () => {
  const r = await reviewViaTechLead(repo, { reviewMaxDurationMs: 1000 }, 5, logger);
  assert.equal(r.fallback, true);
});

test("the configured label names reach the Tech Lead as they reach Claude", async () => {
  const cfg = fakeTechLead('console.log(`labels ${process.env.FOREMAN_TRIGGER_LABEL} ${process.env.FOREMAN_LIFECYCLE_LABELS}`); process.exit(3);');
  const labelled = { ...repo, triggerLabel: "go", lifecycleLabels: { prUnderReview: "in-review", prPendingActions: "needs-changes" } };
  const r = await reviewViaTechLead(labelled, cfg, 5, logger);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /labels go \{"prUnderReview":"in-review","prPendingActions":"needs-changes"\}/);
});

// foreman#180: a transient GitHub error inside the Tech Lead is a defer, never a charged failure.
test("a non-zero exit whose stderr is a TLS handshake timeout is deferred like exit 3, flagged transient", async () => {
  const cfg = fakeTechLead('console.error(\'review-pr failed: gh pr view 7: Post "https://api.github.com/graphql": net/http: TLS handshake timeout\'); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /TLS handshake timeout/);
});

test("5xx, ECONNRESET, ENOTFOUND and dial tcp on stderr are deferred", async () => {
  for (const msg of ["HTTP 502: Bad Gateway", "read ECONNRESET", "getaddrinfo ENOTFOUND api.github.com", "dial tcp 140.82.1.1:443: i/o timeout"]) {
    const cfg = fakeTechLead(`console.error(${JSON.stringify(`review-pr failed: ${msg}`)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal(r.fallback, true, msg);
  }
});

test("auth, 404, 422 and rate-limit failures stay failures", async () => {
  for (const msg of ["HTTP 401: Bad credentials", "HTTP 404: Not Found", "HTTP 422: Validation Failed", "API rate limit exceeded", "merge conflicts"]) {
    const cfg = fakeTechLead(`console.error(${JSON.stringify(`review-pr failed: ${msg}`)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal("fallback" in r, false, msg);
    assert.equal(r.success, false, msg);
  }
});

test("exit 3 from the Tech Lead's own github-unavailable is a transient defer; exit 3 for Codex stays the visible wait", async () => {
  const cfg = fakeTechLead('console.log("GitHub unavailable after 4 attempts — nothing written; retry later."); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.unavailable, true);
  const codex = fakeTechLead('console.log("Codex first read failed (signed-out) — nothing written"); process.exit(3);');
  const c = await reviewViaTechLead(repo, codex, 7, logger);
  assert.equal(c.fallback, true);
  assert.equal(c.unavailable, undefined);
});

test("exit 3 with a TLS timeout on stderr is deferred the same as exit 1", async () => {
  const cfg = fakeTechLead('console.error("gh pr view 7: net/http: TLS handshake timeout"); console.log("retry later"); process.exit(3);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.unavailable, true);
});

test("HTTP 500 on stderr is deferred, transient, not a failure", async () => {
  const cfg = fakeTechLead('console.error("review-pr failed: gh pr view 7: HTTP 500: Internal Server Error"); process.exit(1);');
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.fallback, true);
  assert.equal(r.unavailable, true);
});

// foreman#392: an empty response on the Tech Lead's GitHub write is a bounded tooling defer, never a claimed review.
const POST = "review-pr failed: gh api --method POST repos/o/r/pulls/7/x: unexpected end of JSON input";

test("exit 1 with an empty-JSON gh POST is deferred as transient and claims no review", async () => {
  for (const line of [POST, "review-pr failed: gh api -X POST repos/o/r/pulls/7/x: unexpected end of JSON input"]) {
    const cfg = fakeTechLead(`console.error(${JSON.stringify(line)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal(r.fallback, true, line);
    assert.equal(r.unavailable, true);
    assert.equal(r.ambiguousPost, true);
    assert.equal("success" in r, false);
    assert.equal("trailers" in r, false);
  }
});

test("a bare JSON parse error, a GET, auth, 404, 422 and rate-limit are not the empty-POST signature", async () => {
  for (const line of [
    "review-pr failed: unexpected end of JSON input",
    "review-pr failed: gh api repos/o/r/pulls/7: unexpected end of JSON input",
    "review-pr failed: gh api --method POST repos/o/r: HTTP 401: Bad credentials",
    "review-pr failed: gh api --method POST repos/o/r: HTTP 403: Forbidden",
    "review-pr failed: gh api --method POST repos/o/r: HTTP 404: Not Found",
    "review-pr failed: gh api --method POST repos/o/r: HTTP 422: Validation Failed",
    "review-pr failed: gh api --method POST repos/o/r: API rate limit exceeded",
    "review-pr failed: gh api --method POST repos/o/r: HTTP 403 rate limit; unexpected end of JSON input",
    "review-pr failed: gh api --method POST repos/o/r/pulls/7/x: HTTP 429: unexpected end of JSON input",
  ]) {
    assert.equal(isEmptyPostResponseError(line), false, line);
    const cfg = fakeTechLead(`console.error(${JSON.stringify(line)}); process.exit(1);`);
    const r = await reviewViaTechLead(repo, cfg, 7, logger);
    assert.equal("fallback" in r, false, line);
    assert.equal(r.success, false, line);
  }
  assert.equal(isEmptyPostResponseError(POST), true);
});

test("a POST path with a refusal-looking number is still the empty-POST signature; with ECONNRESET it still carries ambiguousPost", async () => {
  for (const n of [401, 403, 404, 422]) assert.equal(isEmptyPostResponseError(`review-pr failed: gh api --method POST repos/o/r/pulls/${n}/x: unexpected end of JSON input`), true, String(n));
  const cfg = fakeTechLead(`console.error(${JSON.stringify(POST + "; ECONNRESET")}); process.exit(1);`);
  const r = await reviewViaTechLead(repo, cfg, 7, logger);
  assert.equal(r.ambiguousPost, true);
  assert.equal(r.unavailable, true);
});
