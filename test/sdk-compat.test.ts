import { describe, expect, it } from "vitest";
import Conductor, { APIConnectionTimeoutError } from "conductor-node";
import { classifyConductorError } from "../src/classify";
import { withStaleRevisionRetry } from "../src/stale-revision";
import { runIncrementalSync } from "../src/sync/incremental-sync";
import { InMemoryCursorStore } from "../src/sync/cursor-store";

// This function is NEVER executed. It exists so `tsc` type-checks conductor-sync
// against the REAL conductor-node signatures. If Conductor changes its API
// shape, the typecheck breaks here instead of in a user's Slack.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _typeCompat(conductor: Conductor, conductorEndUserId: string) {
  // Classifier accepts a real SDK error instance.
  classifyConductorError(new APIConnectionTimeoutError());

  // Incremental sync wired to the real list() PagePromise; TRecord infers as
  // SalesOrder, so `so.updatedAt` must exist on the real type.
  await runIncrementalSync({
    key: "sales-orders",
    cursorStore: new InMemoryCursorStore(),
    listUpdated: (since) =>
      conductor.qbd.salesOrders.list({ conductorEndUserId, updatedAfter: since ?? undefined }),
    getUpdatedAt: (so) => so.updatedAt,
    onRecord: async (so) => void so.id,
  });

  // Stale-revision retry against the real update()/retrieve() signatures.
  // Note the recommended `{ maxRetries: 0 }`: a 3200 comes back as an HTTP 502,
  // and the SDK replays the same request body on retry (it never refetches the
  // revision), so disabling retries here avoids replaying the stale
  // revisionNumber. conductor-sync owns the refetch and retry.
  await withStaleRevisionRetry("1", {
    write: (revisionNumber) =>
      conductor.qbd.salesOrders.update(
        "so_1",
        { conductorEndUserId, revisionNumber, memo: "synced" },
        { maxRetries: 0 }
      ),
    refreshRevision: async () =>
      (await conductor.qbd.salesOrders.retrieve("so_1", { conductorEndUserId })).revisionNumber,
  });
}

describe("conductor-node type compatibility", () => {
  it("compiles the documented integration against the real SDK types", () => {
    expect(typeof _typeCompat).toBe("function");
  });
});
