# Building a durable sync engine on Conductor

> Companion guide to `conductor-sync`. Conductor's SDK gives you a fully-typed
> call layer with auto-pagination, retries, and timeouts. What it deliberately
> leaves to you is the *orchestration* around it: a persisted change cursor, and
> a durable outbound queue that survives QBD being offline. This guide shows the
> patterns; `conductor-sync` is one small implementation.

## 1. Incremental pull (change data capture)

Conductor exposes `updatedAfter` filters and the `deleted-transactions` /
`deleted-list-objects` endpoints. To turn those into a resumable change feed you
need to persist a **watermark**, the timestamp of the last change you
processed, and advance it only as records succeed.

```ts
import Conductor from "conductor-node";
import { runIncrementalSync } from "conductor-sync";

const conductor = new Conductor({ apiKey: process.env.CONDUCTOR_SECRET_KEY });
const conductorEndUserId = process.env.CONDUCTOR_END_USER_ID!;

await runIncrementalSync({
  key: "sales-orders",
  cursorStore, // your CursorStore, one row holding an ISO timestamp

  listUpdated: (since) =>
    // SDK auto-paginates; the returned PagePromise is iterated directly.
    conductor.qbd.salesOrders.list({ conductorEndUserId, updatedAfter: since ?? undefined }),
  getUpdatedAt: (so) => so.updatedAt,
  onRecord: (so) => upsertLocally(so), // idempotent

  listDeleted: (since) =>
    conductor.qbd.deletedTransactions.list({
      conductorEndUserId,
      transactionTypes: ["sales_order"],
      deletedAfter: since ?? undefined,
    }),
  getDeletedAt: (d) => d.deletedAt,
  onDelete: (d) => removeLocally(d.id),

  overlapMs: 60_000, // re-scan 1 min each run as a same-timestamp safety net
});
```

Key properties:

- **Resumable.** Records are processed in ascending `updatedAt`; the watermark
  advances per record. If a handler throws, the cursor persists up to the last
  success and the next run resumes there, so nothing is skipped.
- **Make handlers idempotent.** With `overlapMs` (and at-least-once delivery in
  general) a record can be delivered twice; upsert, don't insert.
- **Deletions after updates.** Deletes are applied only once the updates in a run
  succeed, so a delete can't outrun the watermark.

## 2. Durable outbound queue (write-back)

QuickBooks Desktop processes requests **serially**, and the Web Connector is
regularly offline (backups, single-user mode, the machine is off overnight). So
write-back can't be fire-and-forget; it needs a queue that retries transient
failures and parks the rest.

```ts
import { processQueue } from "conductor-sync";

await processQueue({
  store: queueStore, // your QueueStore
  send: (payload) =>
    conductor.qbd.salesOrders.update(
      payload.id,
      { conductorEndUserId, revisionNumber: payload.revisionNumber, memo: payload.memo },
      { maxRetries: 0 } // the queue owns durable retries
    ),
  // classify + backoff default to conductor-sync's QBD-tuned behavior:
  //   transient (timeouts, 5xx, 429, 3200, downed connection) → retry w/ backoff
  //   permanent (validation 4xx) → dead-letter immediately
  maxAttempts: 8,
});
```

Properties:

- **Sequential by design:** one job at a time, matching QBD's serial model.
- **Head-of-line safe:** a permanently failing job is dead-lettered, not left
  blocking the queue; a job awaiting retry is scheduled into the future so the
  drain moves on.
- **One attempt per job per drain:** a rescheduled job is retried on the next
  run, never spun in a tight loop.

## Bring your own storage

conductor-sync ships in-memory `CursorStore` / `QueueStore` implementations for
tests and local dev. In production, implement the two small interfaces against
your database. A minimal Postgres/Prisma sketch:

```ts
const cursorStore: CursorStore = {
  get: async (key) =>
    (await prisma.syncCursor.findUnique({ where: { key } }))?.value ?? null,
  set: async (key, value) =>
    void prisma.syncCursor.upsert({
      where: { key }, create: { key, value }, update: { value },
    }),
};
```

The `QueueStore` maps to a `jobs` table with `status`, `attempt`, and
`nextRunAt` columns; `claimNext` is a `SELECT … WHERE status='ready' AND
nextRunAt <= now() ORDER BY nextRunAt LIMIT 1 FOR UPDATE SKIP LOCKED` followed
by an update to `running`, which also makes it safe to run multiple workers.
