// Stage stalls: a card that waits in a stage no other stall cause covers still gets an owner.
//
// The other causes start on an event a phase sees (a deferred check, a failed handoff, a held release). A card
// left at one of the stages below raised nothing: no phase fails, it is simply not moved, so it sat past two hours
// with nobody asked. The owners follow the process map (the stage policy's owner of each stage): the Foreman builds
// (`approved`) and re-verifies (`prodVerifyHeld`) these itself, so a stall there is a Foreman fault and the
// `stalled` raise takes it to the EM seat; the outcome gate (`pendingVerification`) and the release
// (`awaitingRelease`, `releasing`, and the sign-off hold `awaitingSignoff`) are the EM's.
//
// A card that already has an unresolved stall of another cause, on its own record or naming it in `affected` (a
// release-level stall is held on its first issue's record), has an owner: no stage stall opens beside it, so one
// wait is never raised twice.
//
// An approved card is queued, not stalled, while another card of the same repo holds the build: it is being built,
// its PR is open under review, or it waits on its revision (`BUILD_STAGES`). The Foreman builds a repo one feature
// PR at a time, so the queue behind it is the stage's meaning ("queued behind an open feature PR"), not a fault.
// The stall opens on the first pass that sees the build free and the card still approved, and a stall already open
// on a card that is now queued resolves (2026-11-28: an S2 card behind ten approved S0 cards while
// a PR was in review, was raised as a Foreman fault).
//
// Read from the work source's own snapshot, the stage the board shows. A stall starts when the unstick pass
// first sees the card at the stage (the record keeps that start; nothing earlier is known), and resolves on
// the first pass that sees the card anywhere else. Dark behind FOREMAN_STALL_CLOCK like every stall.

import type { StageOrDone } from "./lifecycle.js";
import type { StallCause, StallRecord } from "./stall-clock.js";

export interface StageStallRule {
  readonly cause: StallCause;
  /** A role or login; "EM" is replaced by the configured escalation owner. */
  readonly resolver: "Foreman" | "EM";
  readonly nextAction: string;
  readonly resumptionCondition: string;
}

export const STAGE_STALL_RULES: Readonly<Partial<Record<StageOrDone, StageStallRule>>> = {
  approved: {
    cause: "stage-approved", resolver: "Foreman",
    nextAction: "Foreman fault: an approved card was not picked up; find what keeps the Foreman from building it",
    resumptionCondition: "the card leaves approved",
  },
  prodVerifyHeld: {
    cause: "stage-prod-verify-held", resolver: "Foreman",
    nextAction: "Foreman fault: production verification is still held; find why the re-verification does not pass",
    resumptionCondition: "the card leaves prod verification held",
  },
  awaitingRelease: {
    cause: "stage-awaiting-release", resolver: "EM",
    nextAction: "give the release go: the card waits on an open release PR the release stage does not own",
    resumptionCondition: "the card leaves awaiting release",
  },
  releasing: {
    cause: "stage-releasing", resolver: "EM",
    nextAction: "take the release: its PR is open and has not reached production",
    resumptionCondition: "the card leaves releasing",
  },
  awaitingSignoff: {
    cause: "stage-awaiting-signoff", resolver: "EM",
    nextAction: "take the sign-off hold: lift it or name what it waits on",
    resumptionCondition: "the card leaves awaiting sign-off",
  },
  pendingVerification: {
    cause: "stage-pending-verification", resolver: "EM",
    nextAction: "run the outcome gate: the card is verified on develop and waits on the EM",
    resumptionCondition: "the card leaves the outcome gate",
  },
};

/** The stages that hold a repo's one build: an approved card behind any of them is queued. */
export const BUILD_STAGES: ReadonlySet<StageOrDone> = new Set<StageOrDone>(["implementing", "inReview", "reviewing", "changesRequested", "revising"]);

export const STAGE_STALL_CAUSES: ReadonlySet<StallCause> = new Set(Object.values(STAGE_STALL_RULES).map((r) => r!.cause));

export interface StageStallPlan {
  /** Cards at a ruled stage with no unresolved stall of that stage's cause: report one. */
  report: Array<{ issue: number; rule: StageStallRule }>;
  /** Unresolved stage stalls on a card that is closed or no longer at their stage: resolve them. */
  resolve: Array<{ issue: number; cause: StallCause }>;
  /** The index after the plan: every issue still holding a stage stall, or whose record could not be read. */
  index: number[];
}

/**
 * What one pass does. `stages`: the open lifecycle cards' stages. `open`: the readable open cards' stalls. `closed`:
 * the readable stalls of indexed cards no longer open. `unreadable`: indexed cards whose record could not be read,
 * left alone and kept in the index for the next pass. Pure.
 */
export function planStageStalls(
  stages: ReadonlyMap<number, StageOrDone>,
  open: ReadonlyMap<number, Partial<Record<StallCause, StallRecord>> | undefined>,
  closed: ReadonlyMap<number, Partial<Record<StallCause, StallRecord>> | undefined>,
  unreadable: Iterable<number>,
  repo: string,
): StageStallPlan {
  const plan: StageStallPlan = { report: [], resolve: [], index: [] };
  const index = new Set<number>(unreadable);
  const live = (stalls: Partial<Record<StallCause, StallRecord>> | undefined, cause: StallCause) => {
    const s = stalls?.[cause];
    return s !== undefined && s.state !== "resolved";
  };
  const other = (stalls: Partial<Record<StallCause, StallRecord>> | undefined) =>
    Object.values(stalls ?? {}).filter((st): st is StallRecord => st !== undefined && st.state !== "resolved" && !STAGE_STALL_CAUSES.has(st.cause));
  const named = new Set<number>();
  for (const stalls of open.values()) for (const st of other(stalls)) for (const a of st.affected) {
    const m = /^(.+)#(\d+)$/.exec(a);
    if (m && m[1].toLowerCase() === repo.toLowerCase()) named.add(Number(m[2]));
  }
  const building = [...stages.values()].some((s) => BUILD_STAGES.has(s));
  for (const [issue, cardStalls] of open) {
    const stage = stages.get(issue);
    const queued = stage === "approved" && building;
    const rule = stage && !queued ? STAGE_STALL_RULES[stage] : undefined;
    for (const cause of STAGE_STALL_CAUSES) {
      if (rule?.cause === cause && (live(cardStalls, cause) || (other(cardStalls).length === 0 && !named.has(issue)))) {
        index.add(issue);
        if (!live(cardStalls, cause)) plan.report.push({ issue, rule });
      } else if (live(cardStalls, cause)) plan.resolve.push({ issue, cause });
    }
  }
  for (const [issue, cardStalls] of closed) {
    for (const cause of STAGE_STALL_CAUSES) if (live(cardStalls, cause)) plan.resolve.push({ issue, cause });
  }
  plan.index = [...index].sort((a, b) => a - b);
  return plan;
}
