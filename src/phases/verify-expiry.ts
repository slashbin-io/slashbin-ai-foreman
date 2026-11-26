// VerifyHoldExpiry: a hold is a card that SHIPPED to production and is awaiting proof there (the release stage's `held`
// phase, label `prod verification held`). It may not wait for ever: past a configured maximum age it gets a terminal
// disposition, "shipped, verification unresolved", with a follow-up card that carries the open question.
//
// A card that has NOT shipped (a dev verify hold, anything unreleased, anything awaiting sign-off) is "blocked", not
// held: it has no maximum age, is never parked, closed or promoted by this module. Only `held` releases come here.
//
// Order is record first, close second: the follow-up is filed (idempotent, so a crash between the two steps is
// finished on the next pass as `existing`), and only then is the card closed. A failed filing never closes the card.
import type { ProdRelease } from "../issue-records.js";
import type { VerifyFollowUpInput, VerifyFollowUpOutcome } from "../plugins/contract.js";
import type { Logger } from "../logger.js";

export type HoldExpiry = "off" | "unclocked" | "running" | "expired";

/**
 * Where a held release stands against the maximum age. `off`: the give-up is not configured (0), or the release is not a
 * production-verification hold (a soak hold is not expired here). `unclocked`: a record written before `originatedAt`
 * existed; the caller stamps it once, from now, so its age can only be an under-count and never shortens a hold.
 */
export function holdExpiry(rel: ProdRelease, nowMs: number, maxAgeMs: number): HoldExpiry {
  if (!(maxAgeMs > 0) || rel.phase !== "held") return "off";
  if (rel.soaked === true || (rel.hold ?? "").startsWith("soak:")) return "off";
  const origin = Date.parse(rel.originatedAt ?? "");
  if (!Number.isFinite(origin)) return "unclocked";
  return nowMs - origin >= maxAgeMs ? "expired" : "running";
}

/** The http(s) links in a hold's evidence text; the follow-up's evidence entries must be URLs. */
export function evidenceLinks(text: string | undefined): string[] {
  return [...new Set((text ?? "").match(/https?:\/\/[^\s)>\]"'`,]+/g)?.map((u) => u.replace(/[.;:]+$/, "")) ?? [])];
}

export interface ExpiryDeps {
  /** True while the card is open (a card already closed has nothing left to close). */
  isOpen(card: number): boolean;
  /** The card's epic, or null when it has none or it cannot be read. */
  epicOf(card: number): Promise<number | null>;
  fileFollowUp(input: VerifyFollowUpInput): Promise<VerifyFollowUpOutcome>;
  /** Close the card as shipped, verification unresolved; true once it is closed. */
  closeCard(card: number): Promise<boolean>;
  /** Say it on the card once it is closed. */
  noteClosed(card: number, followUpUrl: string): Promise<void>;
}

export interface ExpiryResult {
  /** Cards closed now, or already closed. */
  done: number[];
  /** Cards left open: a follow-up that could not be filed, or a close that did not land. Retried next pass. */
  kept: number[];
}

/** Expire every open card of one held release: file its follow-up, then close it. */
export async function expireHeldRelease(rel: ProdRelease, cards: readonly number[], owner: string, deps: ExpiryDeps, logger: Logger): Promise<ExpiryResult> {
  const out: ExpiryResult = { done: [], kept: [] };
  for (const card of cards) {
    if (!deps.isOpen(card)) { out.done.push(card); continue; }
    const filed = await deps.fileFollowUp({
      prNumber: rel.pr, card, originatedAt: rel.originatedAt ?? "", reason: rel.hold ?? "", verdict: rel.hold ?? "",
      evidence: evidenceLinks(rel.evidence), epic: await deps.epicOf(card), owner,
    });
    if (filed.kind === "failed") {
      logger.warn(`Release PR #${rel.pr}: #${card} is past its maximum hold age but its follow-up was not filed (${filed.detail}); it stays open and is tried again next pass`);
      out.kept.push(card);
      continue;
    }
    if (!(await deps.closeCard(card))) { out.kept.push(card); continue; }
    await deps.noteClosed(card, filed.url);
    out.done.push(card);
  }
  return out;
}
