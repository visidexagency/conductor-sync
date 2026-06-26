// Classify a Conductor error as transient (worth retrying) or permanent
// (retrying can never succeed, dead-letter it). This is the decision a
// durable outbound queue needs and the SDK leaves to you.
//
// Generalized from a production QuickBooks Desktop write-back pipeline.

import { isStaleRevisionError, unwrapConductorError } from "./stale-revision";

export type ConductorErrorClass = "transient" | "permanent";

/**
 * Default classifier for Conductor / QBD write failures.
 *
 * Transient (retry): network timeouts, connection errors, HTTP 5xx, 429,
 * stale edit-sequence (3200), and a downed QBD connection (which Conductor
 * sometimes reports as a 4xx whose message says "connection … not active").
 * Auth errors (401/403) are treated as transient too, the usual cause is a
 * rotated/revoked key, which an operator fixes; bounded retries cap the loop
 * rather than dead-lettering every in-flight job at once.
 *
 * Permanent (dead-letter): other 4xx (validation, not-found, malformed).
 *
 * Unknown shapes default to transient, the safe choice, since a bounded
 * attempt budget will dead-letter them eventually anyway.
 */
export function classifyConductorError(err: unknown): ConductorErrorClass {
  const name = (err as { name?: string } | null)?.name;
  if (name === "APIConnectionTimeoutError" || name === "APIConnectionError") {
    return "transient";
  }
  if (isStaleRevisionError(err)) return "transient";

  const body = unwrapConductorError(err);
  const status =
    (err as { status?: number } | null)?.status ?? body?.httpStatusCode;

  if (typeof status === "number") {
    if (status >= 500 || status === 429) return "transient";
    if (status === 401 || status === 403) return "transient";
  }

  const message = body?.message ?? (err instanceof Error ? err.message : "");
  if (
    body?.code === "QBD_CONNECTION_ERROR" ||
    body?.code === "INTEGRATION_CONNECTION_ERROR" ||
    /connection.*not.*active/i.test(message)
  ) {
    return "transient";
  }

  if (typeof status === "number" && status >= 400 && status < 500) {
    return "permanent";
  }
  return "transient";
}
