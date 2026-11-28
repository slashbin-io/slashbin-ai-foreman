/**
 * A short-lived memo for GitHub reads that several stages or lanes repeat within one pass.
 *
 * 2026-11-28: the Foreman spent 4,968 of 5,000 GraphQL points an hour idle, because every lane re-read what
 * another had just read (the release PR's sign-off status once per issue per pass). A read memoised here is
 * shared by every caller for `ttlMs` (default off, so tests and a hand-built runtime read live), and by every
 * caller that arrives while it is in flight. A failed read is never kept. Any gh write clears the lot
 * (`invalidateSnapshotIfMutating`), so the Foreman never reads a state its own write has changed.
 *
 * A leaf module on purpose: `github/cache.ts` and the readers both import it.
 */

let ttlMs = 0;
const store = new Map<string, { at: number; value: Promise<unknown> }>();

/** Set the memo window (ms); 0 turns it off and drops what it holds. */
export function configureReadMemo(ms: number): void {
  ttlMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  store.clear();
}

/** Drop everything memoised (a write happened). */
export function clearReadMemo(): void {
  store.clear();
}

/** `read()` once per `key` per window; concurrent and repeat callers share the one answer. */
export function memoRead<T>(key: string, read: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  if (ttlMs <= 0) return read();
  const hit = store.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = read();
  const entry = { at: now(), value };
  store.set(key, entry);
  // A failure is not an answer: the next caller asks again.
  value.catch(() => { if (store.get(key) === entry) store.delete(key); });
  return value;
}
