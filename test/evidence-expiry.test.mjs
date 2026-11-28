// `awaiting evidence` expires like a prod hold: same max age, a follow-up through the EM plugin, closed with the bar quoted.
import test from "node:test";
import assert from "node:assert/strict";
import { evidenceBar, expireAwaitingEvidence, AWAITING_EVIDENCE_LABEL } from "../dist/phases/evidence-expiry.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-28T12:00:00Z");
const MAX = 7 * DAY;
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const BODY = "## Why\nx\n\n## Done condition\n\n    Called by:  a\n    Done when:  dev test passes\n                AND count = 0\n    Read from:  db\n\n## Other\nignore\n";

function deps(over = {}) {
  const calls = { filed: [], closed: [], released: [] };
  const d = {
    openLabeled: async () => [1],
    newestEventAt: async () => NOW - 8 * DAY,
    readBody: async () => BODY,
    shipped: async () => true,
    epicOf: () => 9,
    fileFollowUp: async (i) => { calls.filed.push(i); return { kind: "filed", issue: 77, url: "https://x/77" }; },
    closeCard: async (n, c) => { calls.closed.push([n, c]); return true; },
    releaseCard: async (n, c) => { calls.released.push([n, c]); return true; },
    ...over,
  };
  return { d, calls };
}

const none = { closed: [], followedUp: [], kept: [] };

test("evidenceBar quotes the Done when lines, up to the next field", () => {
  assert.equal(evidenceBar(BODY), "Done when: dev test passes AND count = 0");
});

test("evidenceBar falls back to the section, then to a note", () => {
  assert.match(evidenceBar("## Done condition\nship it\n"), /ship it/);
  assert.equal(evidenceBar("no section"), "the card records no evidence bar");
});

test("a card older than the max age that went through a release is closed with the bar", async () => {
  const { d, calls } = deps();
  const r = await expireAwaitingEvidence(NOW, MAX, "owner", d, logger);
  assert.deepEqual(r, { closed: [1], followedUp: [], kept: [] });
  assert.equal(calls.filed.length, 0);
  assert.match(calls.closed[0][1], /evidence this card waited on was not met in .*Done when: dev test passes AND count = 0/s);
  assert.match(calls.closed[0][1], /went through a release/);
});

test("a card inside the max age is left alone", async () => {
  const { d, calls } = deps({ newestEventAt: async () => NOW - 6 * DAY });
  assert.deepEqual(await expireAwaitingEvidence(NOW, MAX, "owner", d, logger), none);
  assert.equal(calls.closed.length + calls.released.length, 0);
});

test("off at 0, and an unreadable timeline leaves the card alone", async () => {
  assert.deepEqual(await expireAwaitingEvidence(NOW, 0, "owner", deps().d, logger), none);
  const b = deps({ newestEventAt: async () => null });
  assert.deepEqual(await expireAwaitingEvidence(NOW, MAX, "owner", b.d, logger), none);
});

test("never released: the follow-up is filed through the plugin and the card is not closed", async () => {
  const { d, calls } = deps({ shipped: async () => false });
  const r = await expireAwaitingEvidence(NOW, MAX, "owner", d, logger);
  assert.deepEqual(r, { closed: [], followedUp: [1], kept: [] });
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.filed[0].reason, AWAITING_EVIDENCE_LABEL);
  assert.equal(calls.filed[0].card, 1);
  assert.equal(calls.filed[0].epic, 9);
  assert.equal(calls.filed[0].owner, "owner");
  assert.equal(calls.filed[0].originatedAt, "2026-11-20T12:00:00Z");
  assert.match(calls.released[0][1], /https:\/\/x\/77/);
});

test("a failed filing changes nothing and keeps the card", async () => {
  const { d, calls } = deps({ shipped: async () => false, fileFollowUp: async () => ({ kind: "failed", detail: "boom" }) });
  const r = await expireAwaitingEvidence(NOW, MAX, "owner", d, logger);
  assert.deepEqual(r, { closed: [], followedUp: [], kept: [1] });
  assert.equal(calls.released.length, 0);
});

test("a failed close keeps the card; one card's throw does not stop the next", async () => {
  const { d } = deps({
    openLabeled: async () => [1, 2],
    readBody: async (n) => { if (n === 1) throw new Error("gh down"); return BODY; },
  });
  assert.deepEqual(await expireAwaitingEvidence(NOW, MAX, "owner", d, logger), { closed: [2], followedUp: [], kept: [1] });
  const f = deps({ closeCard: async () => false });
  assert.deepEqual((await expireAwaitingEvidence(NOW, MAX, "owner", f.d, logger)).kept, [1]);
});
