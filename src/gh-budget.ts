import type { Logger } from "./logger.js";

/**
 * A proactive GitHub quota guard. The reactive back-off (upstream-backoff.ts) acts only after a call is refused,
 * by which point every other seat on the account (EM, Tech Lead, SRE) is already starved. This one acts first:
 * when what remains of the hourly GraphQL or core budget falls below a reserve, an idle lane sleeps longer, so the
 * Foreman stops spending into the share other seats need. Work is never slowed: a pass that did work goes straight
 * round again (daemon.ts); only the idle nap stretches.
 *
 * The reading is GitHub's own `rate_limit` endpoint, which does not count against the limit:
 * https://docs.github.com/en/rest/rate-limit/rate-limit. The GraphQL bucket is reported there too.
 *
 * A leaf module: the code host registers how the reading is taken (`setBudgetReader`), as it does the back-off probe.
 */

export interface BucketReading {
  remaining: number;
  limit: number;
  /** Epoch seconds when the bucket refills. */
  reset?: number;
}

export interface BudgetReading {
  graphql?: BucketReading;
  core?: BucketReading;
}

export interface BudgetOptions {
  /** Fraction of each bucket kept for other seats; below it, polling slows. */
  reserveFraction: number;
  /** The most an idle interval is stretched. */
  maxFactor: number;
  /** How long a reading is reused. */
  refreshMs: number;
}

export const DEFAULT_BUDGET: BudgetOptions = { reserveFraction: 0.4, maxFactor: 8, refreshMs: 60_000 };

/**
 * How many times longer an idle lane sleeps for this reading: 1 while both buckets hold at least the reserve,
 * then `reserve / fractionLeft`, so it reaches 2 at half the reserve and `maxFactor` near empty. Pure.
 */
export function pollSlowdown(reading: BudgetReading, opts: BudgetOptions = DEFAULT_BUDGET): number {
  let left = 1;
  for (const b of [reading.graphql, reading.core]) {
    if (!b || !(b.limit > 0) || !Number.isFinite(b.remaining)) continue;
    left = Math.min(left, Math.max(0, b.remaining) / b.limit);
  }
  if (left >= opts.reserveFraction) return 1;
  return Math.min(opts.maxFactor, opts.reserveFraction / Math.max(left, 0.001));
}

export type BudgetReader = () => Promise<BudgetReading>;

let reader: BudgetReader | undefined;

/** Register how the quota is read (github/gh.ts, where gh is spawned). Unset: the guard never slows. */
export function setBudgetReader(r: BudgetReader | undefined): void {
  reader = r;
}

/** The daemon's one guard: every lane loop asks it, so the quota is read at most once per `refreshMs`. */
export class BudgetGuard {
  private reading: BudgetReading = {};
  private at = -Infinity;
  private inflight: Promise<void> | null = null;
  private last = 1;

  constructor(
    private readonly logger: Logger,
    private readonly opts: BudgetOptions = DEFAULT_BUDGET,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current slowdown factor, reading the quota first when the last reading is stale. Never throws. */
  async factor(): Promise<number> {
    if (!reader) return 1;
    if (this.now() - this.at >= this.opts.refreshMs) {
      this.inflight ??= reader().then(
        (r) => { this.reading = r; this.at = this.now(); },
        () => { this.at = this.now(); }, // an unreadable quota keeps the last reading, and is retried next window
      ).finally(() => { this.inflight = null; });
      await this.inflight;
    }
    const f = pollSlowdown(this.reading, this.opts);
    if ((f > 1) !== (this.last > 1)) {
      const pct = (b?: BucketReading) => (b && b.limit > 0 ? `${Math.round((100 * b.remaining) / b.limit)}%` : "?");
      if (f > 1) {
        this.logger.warn(`GitHub budget below the ${Math.round(this.opts.reserveFraction * 100)}% reserve (graphql ${pct(this.reading.graphql)}, core ${pct(this.reading.core)} left); idle polls slowed ${f.toFixed(1)}x`);
      } else {
        this.logger.info("GitHub budget back above its reserve; idle polling at its normal interval");
      }
    }
    this.last = f;
    return f;
  }
}
