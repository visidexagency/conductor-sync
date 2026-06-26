// Detect and recover from QuickBooks Desktop's "edit sequence out of date"
// conflict (QBD error 3200) when writing back through the Conductor API.
//
// Why this exists: QBD uses optimistic concurrency. Every record carries an
// edit sequence, Conductor surfaces it as `revisionNumber`. To update a
// record you must send the revisionNumber you last read. If anyone (an office
// user in QuickBooks, another integration) changes that record in between,
// your write is rejected with:
//
//   type:            INTEGRATION_ERROR
//   code:            QBD_REQUEST_ERROR
//   integrationCode: "3200"
//   httpStatusCode:  502
//   message:         'QBD Request Error (3200): The provided revision number
//                     (edit sequence) "..." is out-of-date.'
//
// The fix is always the same: re-fetch the record to get the current
// revisionNumber, then replay the write. `withStaleRevisionRetry` does that
// loop for you.

/** The unwrapped Conductor error envelope (top-level fields). */
export interface ConductorErrorBody {
  message?: string;
  userFacingMessage?: string;
  type?: string;
  code?: string;
  integrationCode?: string;
  httpStatusCode?: number;
  requestId?: string;
}

/**
 * Pull the Conductor error envelope out of whatever the SDK threw.
 *
 * conductor-node attaches the HTTP response body on `err.error`, and the
 * Conductor envelope nests the real error under a further `.error` key, so
 * the documented access path is `err.error.error`. Their SDK errors are
 * acknowledged to be "a bit janky," so we also probe one level up as a
 * fallback. Returns null when no recognizable envelope is present.
 */
export function unwrapConductorError(err: unknown): ConductorErrorBody | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const candidates: unknown[] = [
    (e.error as Record<string, unknown> | undefined)?.error, // err.error.error (documented)
    e.error, // err.error (one-level fallback)
    e, // the error object itself (some shapes flatten it)
  ];
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      ("code" in c || "integrationCode" in c || "type" in c)
    ) {
      return c as ConductorErrorBody;
    }
  }
  return null;
}

/**
 * True when `err` is a QBD stale edit-sequence (revision) conflict.
 *
 * Primary signal is integrationCode "3200", the precise QBD error. We also
 * accept a QBD_REQUEST_ERROR/INVALID_REQUEST_ERROR whose message mentions the
 * edit sequence, in case the wrapper drops the integrationCode, and fall back
 * to matching the raw error text as a last resort.
 */
export function isStaleRevisionError(err: unknown): boolean {
  const body = unwrapConductorError(err);
  if (body) {
    if (body.integrationCode === "3200") return true;
    if (body.code === "QBD_REQUEST_ERROR" || body.code === "INVALID_REQUEST_ERROR") {
      return /edit.?sequence|revision number/i.test(body.message ?? "");
    }
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /(edit.?sequence|revision number)[^.]*out.?of.?date/i.test(msg);
}

export interface StaleRevisionRetryOptions<T> {
  /** Perform the write with the given revisionNumber; return the updated record. */
  write: (revisionNumber: string) => Promise<T>;
  /** Re-fetch the record and return its current revisionNumber. */
  refreshRevision: () => Promise<string>;
  /** Max refetch→rewrite attempts after the first failure. Default 3. */
  maxRetries?: number;
  /** Called each time a stale-revision conflict is detected and retried. */
  onConflict?: (attempt: number) => void;
}

/**
 * Run a Conductor write, transparently recovering from stale edit-sequence
 * conflicts. On a 3200 the helper calls `refreshRevision()` for the current
 * value and replays `write()`. Non-stale errors propagate immediately; the
 * loop gives up after `maxRetries` conflicts and rethrows the last error.
 *
 * @example
 * const updated = await withStaleRevisionRetry(salesOrder.revisionNumber, {
 *   write: (rev) =>
 *     conductor.qbd.salesOrders.update(id, { revisionNumber: rev, memo }, { conductorEndUserId }),
 *   refreshRevision: async () =>
 *     (await conductor.qbd.salesOrders.retrieve(id, { conductorEndUserId })).revisionNumber,
 * });
 */
export async function withStaleRevisionRetry<T>(
  initialRevisionNumber: string,
  opts: StaleRevisionRetryOptions<T>
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  let revisionNumber = initialRevisionNumber;
  for (let attempt = 0; ; attempt++) {
    try {
      return await opts.write(revisionNumber);
    } catch (err) {
      if (attempt >= maxRetries || !isStaleRevisionError(err)) throw err;
      opts.onConflict?.(attempt + 1);
      revisionNumber = await opts.refreshRevision();
    }
  }
}
