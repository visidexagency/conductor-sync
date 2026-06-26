# conductor-sync

Small, battle-tested helpers for **reliable QuickBooks Desktop sync and write-back** on top of the official [`conductor-node`](https://github.com/conductor-is/quickbooks-desktop-node) SDK.

It sits on top of the SDK rather than wrapping or replacing it, and fills the orchestration gaps `conductor-node` deliberately leaves to you:

1. **Edit-sequence (3200) conflict recovery:** transparently retry the "revision number out-of-date" error QuickBooks throws when a record changes between your read and your write.
2. **A resumable sync engine:** incremental change-data-capture with a persisted watermark, plus a durable write-back queue with retry classification and dead-lettering.
3. **An offline mock client:** build and test in CI without a live Conductor account, a Windows box, or the Web Connector. It enforces real optimistic-concurrency, so it round-trips with the retry helper.

```bash
npm install conductor-sync
# conductor-node is an optional peer dependency (only needed in your real code path)
```

Want to see it run first? Clone the repo and `npm run example` ([examples/sync-sales-orders.ts](examples/sync-sales-orders.ts)) walks a full pull and write-back against the mock, no credentials needed, including a 3200 conflict that recovers on its own.

## 1. Recover from edit-sequence (3200) conflicts

QuickBooks Desktop uses optimistic concurrency. Every record carries an edit sequence, which Conductor exposes as `revisionNumber`. To update a record you send the `revisionNumber` you last read; if anyone edits that record in between (an office user in QuickBooks, or another integration), the write is rejected:

```
QBD Request Error (3200): The provided revision number (edit sequence) "..." is out-of-date.
```

The fix is always the same: re-fetch for the current `revisionNumber`, then replay the write. `withStaleRevisionRetry` does that loop:

```ts
import Conductor from "conductor-node";
import { withStaleRevisionRetry } from "conductor-sync";

const conductor = new Conductor({ apiKey: process.env.CONDUCTOR_SECRET_KEY });
const conductorEndUserId = process.env.CONDUCTOR_END_USER_ID!;

const updated = await withStaleRevisionRetry(salesOrder.revisionNumber, {
  write: (revisionNumber) =>
    conductor.qbd.salesOrders.update(
      salesOrder.id,
      { conductorEndUserId, revisionNumber, memo: "Picked & packed" },
      { maxRetries: 0 } // see note below
    ),
  refreshRevision: async () =>
    (await conductor.qbd.salesOrders.retrieve(salesOrder.id, { conductorEndUserId }))
      .revisionNumber,
  onConflict: (attempt) => console.warn(`stale revision, refetching (attempt ${attempt})`),
});
```

Non-stale errors propagate immediately; the loop gives up after `maxRetries` (default 3) and rethrows the last error.

> **Why `{ maxRetries: 0 }`?** A 3200 comes back as an HTTP 502, which falls under the SDK's default retry-on-5xx rule, and the SDK replays the *same* request body on retry (it never refetches the revision). Passing `maxRetries: 0` keeps it from replaying the stale `revisionNumber`, and leaves the refetch-and-replay to `conductor-sync`.

Need just the predicate (e.g. to classify errors in your own retry queue)?

```ts
import { isStaleRevisionError } from "conductor-sync";

if (isStaleRevisionError(err)) {
  // transient: safe to refetch and retry
}
```

It checks `integrationCode === "3200"` first, then falls back to the error code plus message text, then to the raw message, so it keeps working even when the SDK's error envelope is incomplete.

## 2. Build a durable sync engine

The SDK gives you a great call layer; it deliberately leaves the *orchestration* to you. `conductor-sync` adds the two pieces every integrator rebuilds (a resumable change cursor and a durable write-back queue) as small, storage-agnostic helpers. You implement two tiny interfaces (`CursorStore`, `QueueStore`) against your DB; in-memory versions ship for tests and local dev.

```ts
import { runIncrementalSync, processQueue } from "conductor-sync";

// Incremental pull: persists a watermark, advances it per record, applies
// deletions, and resumes from the last success if a handler throws.
await runIncrementalSync({
  key: "sales-orders",
  cursorStore,
  listUpdated: (since) =>
    conductor.qbd.salesOrders.list({ conductorEndUserId, updatedAfter: since ?? undefined }),
  getUpdatedAt: (so) => so.updatedAt,
  onRecord: (so) => upsertLocally(so),
});

// Durable write-back: sequential (QBD is serial), retries transient failures
// with backoff, dead-letters permanent ones, head-of-line safe.
await processQueue({
  store: queueStore,
  send: (payload) =>
    conductor.qbd.salesOrders.update(
      payload.id,
      { conductorEndUserId, revisionNumber: payload.revisionNumber, memo: payload.memo },
      { maxRetries: 0 } // the queue owns durable retries
    ),
  maxAttempts: 8, // classify + backoff default to QBD-tuned behavior
});
```

See [docs/building-a-sync-engine.md](docs/building-a-sync-engine.md) for the full walk-through, including the Postgres/Prisma store sketch and the `FOR UPDATE SKIP LOCKED` claim query for multi-worker setups.

## 3. Develop and test offline with the mock client

`MockConductor` mirrors `conductor.qbd.salesOrders.{list,retrieve,update,create}` against an in-memory store. It enforces the same optimistic-concurrency rules as production: a stale `revisionNumber` throws a `3200` shaped exactly like Conductor's, so your conflict-handling code is exercised for real in tests.

```ts
import { MockConductor } from "conductor-sync";

const conductor = new MockConductor({
  salesOrders: [
    {
      id: "so-1", objectType: "qbd_sales_order", revisionNumber: "1",
      refNumber: "SO-1001", customer: { id: "c1", fullName: "Acme" },
      memo: null, transactionDate: "2026-06-01",
      createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", lines: [],
    },
  ],
});

await conductor.qbd.salesOrders.update("so-1", { revisionNumber: "1", memo: "ok" }); // revisionNumber becomes "2"
```

Simulate a concurrent QuickBooks edit to test your retry path: `armStaleRevision` makes the next update throw `3200` once, advancing the stored revision behind your back:

```ts
const orders = conductor.qbd.salesOrders;
orders.armStaleRevision("so-1");

// withStaleRevisionRetry refetches and succeeds, with no live account required.
await withStaleRevisionRetry("1", {
  write: (rev) => orders.update("so-1", { revisionNumber: rev, memo: "synced" }),
  refreshRevision: async () => (await orders.retrieve("so-1")).revisionNumber,
});
```

The mock covers Sales Orders, the common write-back entity. The same pattern extends to any QBD object: copy `MockSalesOrdersResource` for invoices, estimates, and so on.

## API

All exports come from the package root (`conductor-sync`).

| Export | Description |
| --- | --- |
| `withStaleRevisionRetry(initialRevision, opts)` | Run a write, auto-recovering from 3200 conflicts via `refreshRevision`. |
| `isStaleRevisionError(err)` | `true` if `err` is a QBD stale edit-sequence conflict. |
| `unwrapConductorError(err)` | Pull the Conductor error envelope out of a thrown SDK error (or `null`). |
| `classifyConductorError(err)` | Classify a failure as `"transient"` or `"permanent"` for a retry queue. |
| `runIncrementalSync(opts)` | Resumable change-data-capture with a persisted watermark plus deletions. |
| `processQueue(opts)` | Drain a durable write-back queue: retry transient, dead-letter permanent. |
| `expBackoff(attempt, opts)` | Capped exponential backoff (QBD-tuned defaults). |
| `CursorStore` / `InMemoryCursorStore` | Watermark persistence contract plus in-memory impl. |
| `QueueStore` / `InMemoryQueueStore` | Queue persistence contract plus in-memory impl. |
| `MockConductor` / `MockSalesOrdersResource` | In-memory stand-in for a conductor-node client (Sales Orders). |

## Notes

- **Not affiliated with Conductor.** A community library, MIT licensed.
- Works fully standalone; `conductor-node` is an optional peer dependency, used only in your production code path, not by the library itself.

---

Built by [Visidex](https://visidex.com) while shipping a QuickBooks Desktop integration on Conductor. PRs welcome.
