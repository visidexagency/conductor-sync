export interface BackoffOptions {
  /** Delay for the first retry. Default 30s. */
  baseMs?: number;
  /** Ceiling on any single delay. Default 30min. */
  maxMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
}

/**
 * Capped exponential backoff. `attempt` is 1-based: attempt 1 returns baseMs,
 * attempt 2 returns baseMs*factor, etc., clamped to maxMs.
 *
 * Defaults are tuned for QuickBooks Desktop: a 30s base over 8 attempts spans
 * ~60 min of backoff, which comfortably outlasts the single-user/backup
 * windows that make QBD writes fail transiently.
 */
export function expBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 30_000;
  const max = opts.maxMs ?? 1_800_000;
  const factor = opts.factor ?? 2;
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(max, base * factor ** (n - 1));
}
