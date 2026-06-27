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
  stableHash,
  InMemoryCursorStore,
  InMemoryQueueStore,
  type MockSalesOrder,
} from "../src/index";

async function main() {
  const conductor = new MockConductor({
    salesOrders: [order("so-1", "SO-1001"), order("so-2", "SO-1002")],
  });

  // 1. Incremental pull. We store a content hash per record so a record whose
  //    content didn't actually change gets skipped: QuickBooks bumps updatedAt
  //    on cosmetic re-saves, so a pull can hand you the same record twice.
  //    (listUpdated returns everything each run here for simplicity; in
  //    production you'd pass updatedAfter. listDeleted plugs in the same way.)
  const local = new Map<string, { refNumber: string; hash: string }>();
  const cursorStore = new InMemoryCursorStore();
  let applied = 0;

  const pull = () =>
    runIncrementalSync({
      key: "sales-orders",
      cursorStore,
      listUpdated: async () => (await conductor.qbd.salesOrders.list()).data,
      getUpdatedAt: (so) => so.updatedAt,
      onRecord: async (so) => {
        const hash = stableHash({ refNumber: so.refNumber, memo: so.memo, lines: so.lines });
        if (local.get(so.id)?.hash === hash) return; // unchanged: skip downstream work
        local.set(so.id, { refNumber: so.refNumber ?? so.id, hash });
        applied++;
      },
    });

  applied = 0;
  await pull();
  console.log(`1. first pull applied ${applied} orders:`, [...local.values()].map((v) => v.refNumber).join(", "));
  applied = 0;
  await pull();
  console.log(`   second pull applied ${applied} (unchanged records skipped via stableHash)`);

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
