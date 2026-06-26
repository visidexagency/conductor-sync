#!/usr/bin/env -S npx tsx
//
// End-to-end conductor-sync loop against the in-memory mock. It runs with no
// API key, no Conductor account, and no Windows/QBD box, so you can see the
// whole thing work before wiring up the real SDK.
//
//   1. incremental pull (cursor-based, so you only fetch what changed)
//   2. write-back through the durable queue
//   3. an edit-sequence (3200) conflict, recovered automatically
//
// Run it:  npm run example
//
// In a real project, swap MockConductor for `new Conductor(...)`, import from
// "conductor-sync", and pass `{ conductorEndUserId }` on each call.

import {
  MockConductor,
  withStaleRevisionRetry,
  runIncrementalSync,
  processQueue,
  InMemoryCursorStore,
  InMemoryQueueStore,
  type MockSalesOrder,
} from "../src/index";

async function main() {
  const conductor = new MockConductor({
    salesOrders: [order("so-1", "SO-1001"), order("so-2", "SO-1002")],
  });

  // 1. Incremental pull. The cursor persists between runs, so a second run with
  //    no changes pulls nothing. `listDeleted` plugs in the same way against the
  //    real deleted-transactions endpoint.
  const local = new Map<string, string>(); // id -> refNumber (stand-in for your DB)
  const cursorStore = new InMemoryCursorStore();

  const pull = await runIncrementalSync({
    key: "sales-orders",
    cursorStore,
    listUpdated: async () => (await conductor.qbd.salesOrders.list()).data,
    getUpdatedAt: (so) => so.updatedAt,
    onRecord: async (so) => void local.set(so.id, so.refNumber ?? so.id),
  });
  console.log(`1. pulled ${pull.processed} orders:`, [...local.values()].join(", "));

  // 2 + 3. Write a memo back through the durable queue. We arm a concurrent
  //    edit on so-1, so its first write hits a 3200; withStaleRevisionRetry
  //    refetches the fresh revision and replays. No error reaches the queue.
  conductor.qbd.salesOrders.armStaleRevision("so-1");

  const queue = new InMemoryQueueStore<{ id: string; memo: string }>();
  queue.enqueue({ id: "so-1", memo: "Picked and packed" });
  queue.enqueue({ id: "so-2", memo: "Picked and packed" });

  const result = await processQueue({
    store: queue,
    send: async ({ id, memo }) => {
      const current = await conductor.qbd.salesOrders.retrieve(id);
      return withStaleRevisionRetry(current.revisionNumber, {
        write: (revisionNumber) =>
          conductor.qbd.salesOrders.update(id, { revisionNumber, memo }),
        refreshRevision: async () =>
          (await conductor.qbd.salesOrders.retrieve(id)).revisionNumber,
        onConflict: (n) =>
          console.log(`   so-1 hit a 3200; refetched and replayed (attempt ${n})`),
      });
    },
  });
  console.log(
    `2. write-back: ${result.succeeded} succeeded, ${result.retried} retried, ${result.deadLettered} dead-lettered`
  );

  console.log("3. final state:");
  for (const id of ["so-1", "so-2"]) {
    const so = await conductor.qbd.salesOrders.retrieve(id);
    console.log(`   ${so.refNumber}: memo="${so.memo}" rev=${so.revisionNumber}`);
  }
}

function order(id: string, refNumber: string): MockSalesOrder {
  const ts = "2026-06-01T00:00:00.000Z";
  return {
    id,
    objectType: "qbd_sales_order",
    revisionNumber: "1",
    refNumber,
    customer: { id: "cust-1", fullName: "Acme" },
    memo: null,
    transactionDate: "2026-06-01",
    createdAt: ts,
    updatedAt: ts,
    lines: [],
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
