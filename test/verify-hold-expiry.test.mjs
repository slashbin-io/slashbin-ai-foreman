// VerifyHoldExpiry: a card that SHIPPED and is held awaiting proof in production gets a terminal disposition past its
// maximum age; a card that has not shipped never does. Fake clock, fake deps: no network, no sleeping.
import test from "node:test";
import assert from "node:assert/strict";
import { holdExpiry, evidenceLinks, expireHeldRelease } from "../dist/phases/verify-expiry.js";
import { backoffConfigSchema, mergeBackoff, DEFAULT_BACKOFF } from "../dist/backoff.js";
import { MOVES } from "../dist/lifecycle.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const MAX = 7 * DAY;
const held = (extra = {}) => ({ pr: 41, headSha: "a".repeat(40), issues: [7], phase: "held", attempts: 3, hold: "healthcheck-red", evidence: "see https://example.test/ev1.", since: "2026-11-01T00:00:00Z", originatedAt: "2026-11-01T00:00:00Z", ...extra });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

test("holdExpiry: off by default, running before the age, expired at it (fake clock)", () => {
  assert.equal(DEFAULT_BACKOFF.holdMaxAgeMs, 0, "the give-up ships dark");
  assert.equal(holdExpiry(held(), T0 + 100 * DAY, 0), "off");
  assert.equal(holdExpiry(held(), T0 + MAX - 1, MAX), "running");
  assert.equal(holdExpiry(held(), T0 + MAX, MAX), "expired");
  assert.equal(holdExpiry(held(), T0 + MAX + DAY, MAX), "expired");
});

test("holdExpiry: only a shipped production hold expires; nothing unshipped or soaking does", () => {
  for (const phase of ["deploying", "merged", "soaking"]) assert.equal(holdExpiry(held({ phase }), T0 + 99 * DAY, MAX), "off", phase);
  assert.equal(holdExpiry(held({ hold: "soak:healthcheck-red" }), T0 + 99 * DAY, MAX), "off", "a soak hold is not expired here");
  assert.equal(holdExpiry(held({ soaked: true }), T0 + 99 * DAY, MAX), "off");
});

test("holdExpiry: a record with no originatedAt is unclocked, never expired from its own age", () => {
  assert.equal(holdExpiry(held({ originatedAt: undefined }), T0 + 99 * DAY, MAX), "unclocked");
  assert.equal(holdExpiry(held({ originatedAt: "garbage" }), T0 + 99 * DAY, MAX), "unclocked");
});

test("evidenceLinks: only URLs, trailing punctuation dropped, deduplicated", () => {
  assert.deepEqual(evidenceLinks("see https://a.test/x. and (https://b.test/y) again https://a.test/x"), ["https://a.test/x", "https://b.test/y"]);
  assert.deepEqual(evidenceLinks(undefined), []);
  assert.deepEqual(evidenceLinks("no links here"), []);
});

function deps(over = {}) {
  const calls = [];
  const d = {
    isOpen: () => true,
    epicOf: async (n) => (n === 7 ? 12 : null),
    fileFollowUp: async (input) => { calls.push(["file", input.card]); return { kind: "filed", issue: 90 + input.card, url: `https://x/${90 + input.card}` }; },
    closeCard: async (n) => { calls.push(["close", n]); return true; },
    noteClosed: async (n, url) => { calls.push(["note", n, url]); },
    ...over,
  };
  return { d, calls };
}

test("expire: files the follow-up first, then closes, then says so; carries the hold's reason, evidence and epic", async () => {
  let seen;
  const { d, calls } = deps({ fileFollowUp: async (input) => { seen = input; calls.push(["file", input.card]); return { kind: "filed", issue: 97, url: "https://x/97" }; } });
  const r = await expireHeldRelease(held(), [7], "em", d, logger);
  assert.deepEqual(calls.map((c) => c[0]), ["file", "close", "note"], "record first, close second");
  assert.deepEqual(r, { done: [7], kept: [] });
  assert.deepEqual(seen, { prNumber: 41, card: 7, originatedAt: "2026-11-01T00:00:00Z", reason: "healthcheck-red", verdict: "healthcheck-red", evidence: ["https://example.test/ev1"], epic: 12, owner: "em" });
  assert.deepEqual(calls.at(-1), ["note", 7, "https://x/97"]);
});

test("expire: a failed filing never closes the card; it is kept for the next pass", async () => {
  const { d, calls } = deps({ fileFollowUp: async () => ({ kind: "failed", detail: "boom" }) });
  const r = await expireHeldRelease(held({ issues: [7, 8] }), [7, 8], "em", d, logger);
  assert.deepEqual(r, { done: [], kept: [7, 8] });
  assert.deepEqual(calls, [], "nothing closed, nothing said");
});

test("expire: a crash between filing and closing is finished next pass as `existing`", async () => {
  let closes = 0;
  const first = deps({ closeCard: async () => { closes++; return false; } });
  assert.deepEqual(await expireHeldRelease(held(), [7], "em", first.d, logger), { done: [], kept: [7] });
  const second = deps({ fileFollowUp: async (i) => { second.calls.push(["file", i.card]); return { kind: "existing", issue: 97, url: "https://x/97" }; } });
  assert.deepEqual(await expireHeldRelease(held(), [7], "em", second.d, logger), { done: [7], kept: [] });
  assert.deepEqual(second.calls.map((c) => c[0]), ["file", "close", "note"]);
  assert.equal(closes, 1);
});

test("expire: an already-closed card is done without a filing; one failure does not stop the others", async () => {
  const { d, calls } = deps({
    isOpen: (n) => n !== 8,
    fileFollowUp: async (i) => (i.card === 7 ? { kind: "failed", detail: "x" } : { kind: "filed", issue: 99, url: "https://x/99" }),
  });
  const r = await expireHeldRelease(held({ issues: [7, 8, 9] }), [7, 8, 9], "em", d, logger);
  assert.deepEqual(r, { done: [8, 9], kept: [7] });
  assert.deepEqual(calls.filter((c) => c[0] === "close").map((c) => c[1]), [9]);
});

test("config: the give-up is off unless set; FOREMAN_HOLD_MAX_AGE (ms) sets it, the generic name wins", () => {
  const was = { a: process.env.FOREMAN_HOLD_MAX_AGE, b: process.env.AI_AGENT_BACKOFF_HOLD_MAX_AGE_MS };
  try {
    delete process.env.FOREMAN_HOLD_MAX_AGE; delete process.env.AI_AGENT_BACKOFF_HOLD_MAX_AGE_MS;
    assert.equal(backoffConfigSchema.parse(mergeBackoff(undefined)).holdMaxAgeMs, 0);
    process.env.FOREMAN_HOLD_MAX_AGE = String(MAX);
    assert.equal(backoffConfigSchema.parse(mergeBackoff(undefined)).holdMaxAgeMs, MAX);
    process.env.AI_AGENT_BACKOFF_HOLD_MAX_AGE_MS = "1000";
    assert.equal(backoffConfigSchema.parse(mergeBackoff(undefined)).holdMaxAgeMs, 1000);
  } finally {
    for (const [k, v] of [["FOREMAN_HOLD_MAX_AGE", was.a], ["AI_AGENT_BACKOFF_HOLD_MAX_AGE_MS", was.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("lifecycle: the expiry move ends at released from the prod hold only (never from an unshipped state)", () => {
  assert.equal(MOVES.prodExpired.from, "prodVerifyHeld");
  assert.equal(MOVES.prodExpired.to, "released");
});
