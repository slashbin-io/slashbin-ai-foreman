// AwaitingEvidenceExpiry: `awaiting evidence` is the EM's label for a card that shipped but whose outcome stays unproven
// until a real-world event can be measured. Nothing read it, so a card whose bar could never be met sat open for ever
// (a service repo card sat 2.5 months on a dev test that needed infrastructure nobody built). It now expires like a production
// verification hold: past `backoff.holdMaxAgeMs` (the same knob, `FOREMAN_HOLD_MAX_AGE`) since its newest timeline event.
//
// A card with a merged PR is closed as shipped, its evidence bar unmet, with the bar quoted. A card with no merged PR has
// nothing shipped to close: its follow-up is filed through the EM plugin (`fileVerifyFollowUp`) and the label is taken off,
// so the card is not re-filed every pass. Record first, change second: a failed filing changes nothing and is retried.
import type { VerifyFollowUpInput, VerifyFollowUpOutcome } from "../plugins/contract.js";
import type { Logger } from "../logger.js";
import { formatWait } from "../backoff.js";

export const AWAITING_EVIDENCE_LABEL = "awaiting evidence";
/** The longest bar quoted on a card. */
const BAR_MAX = 800;

/**
 * The evidence bar a card waited on: its `Done when:` lines (to the next `Read from:` / `Baseline:` / `Called by:` line)
 * under `## Done condition`; else that whole section; else a line saying none is recorded.
 */
export function evidenceBar(body: string): string {
  const section = /^#{1,6}\s*Done condition\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(body)?.[1] ?? "";
  const lines = section.split("\n");
  const start = lines.findIndex((l) => /^\s*Done when:/i.test(l));
  let text: string;
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^\s*(Read from|Baseline|Called by):/i.test(l));
    text = lines.slice(start, end > start ? end : undefined).map((l) => l.trim()).join(" ");
  } else {
    text = section.replace(/\s+/g, " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "the card records no evidence bar";
  return text.length > BAR_MAX ? `${text.slice(0, BAR_MAX - 1)}…` : text;
}

export interface EvidenceExpiryDeps {
  /** Open issues carrying the label. */
  openLabeled(): Promise<number[]>;
  /** The newest timeline event's time (ms); null when it cannot be read (the card is left alone). */
  newestEventAt(card: number): Promise<number | null>;
  readBody(card: number): Promise<string>;
  /** The merged PR that implemented the card, or null. */
  mergedPr(card: number): Promise<number | null>;
  epicOf(body: string): number | null;
  fileFollowUp(input: VerifyFollowUpInput): Promise<VerifyFollowUpOutcome>;
  /** Comment, close as completed and take the label off; true once closed. */
  closeCard(card: number, comment: string): Promise<boolean>;
  /** Comment and take the label off, leaving the card open; true once done. */
  releaseCard(card: number, comment: string): Promise<boolean>;
}

export interface EvidenceExpiryResult { closed: number[]; followedUp: number[]; kept: number[] }

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** Expire every `awaiting evidence` card whose newest event is `maxAgeMs` old. Off at 0. Never throws on one card's failure. */
export async function expireAwaitingEvidence(
  nowMs: number, maxAgeMs: number, owner: string, deps: EvidenceExpiryDeps, logger: Logger,
): Promise<EvidenceExpiryResult> {
  const out: EvidenceExpiryResult = { closed: [], followedUp: [], kept: [] };
  if (!(maxAgeMs > 0)) return out;
  for (const card of await deps.openLabeled()) {
    try {
      const at = await deps.newestEventAt(card);
      if (at === null || nowMs - at < maxAgeMs) continue;
      const age = formatWait(nowMs - at);
      const body = await deps.readBody(card);
      const bar = evidenceBar(body);
      const pr = await deps.mergedPr(card);
      if (pr !== null) {
        const ok = await deps.closeCard(card,
          `**Shipped, evidence bar not met.** PR #${pr} merged, but the evidence this card waited on was not met in ${age}, the maximum. ` +
          `It was never verified. The bar it waited on: ${bar}`);
        (ok ? out.closed : out.kept).push(card);
        continue;
      }
      const filed = await deps.fileFollowUp({
        prNumber: 0, card, originatedAt: isoSeconds(at), reason: AWAITING_EVIDENCE_LABEL,
        verdict: `the evidence bar was not met in ${age}: ${bar}`, evidence: [], epic: deps.epicOf(body), owner,
      });
      if (filed.kind === "failed") {
        logger.warn(`#${card} is past its maximum \`${AWAITING_EVIDENCE_LABEL}\` age but its follow-up was not filed (${filed.detail}); tried again next pass`);
        out.kept.push(card);
        continue;
      }
      const ok = await deps.releaseCard(card,
        `**No merged PR, evidence bar not met.** This card waited on evidence for ${age}, the maximum, and no PR of it has merged. ` +
        `The open question moved to ${filed.url}; the \`${AWAITING_EVIDENCE_LABEL}\` label is removed. The bar it waited on: ${bar}`);
      (ok ? out.followedUp : out.kept).push(card);
    } catch (err) {
      logger.warn(`#${card}: \`${AWAITING_EVIDENCE_LABEL}\` expiry failed: ${err instanceof Error ? err.message : String(err)}`);
      out.kept.push(card);
    }
  }
  return out;
}
