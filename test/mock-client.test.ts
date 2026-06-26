import { describe, expect, it } from "vitest";
import { MockConductor, MockStaleRevisionError } from "../src/mock-client";
import { isStaleRevisionError, withStaleRevisionRetry } from "../src/stale-revision";

function seeded() {
  return new MockConductor({
    salesOrders: [
      {
        id: "so-1",
        objectType: "qbd_sales_order",
        revisionNumber: "1",
        refNumber: "SO-1001",
        customer: { id: "cust-1", fullName: "Acme" },
        memo: null,
        transactionDate: "2026-06-01",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        lines: [],
      },
    ],
  });
}

describe("MockConductor sales orders", () => {
  it("retrieves a seeded order", async () => {
    const so = await seeded().qbd.salesOrders.retrieve("so-1");
    expect(so.refNumber).toBe("SO-1001");
  });

  it("throws a not-found error for unknown ids", async () => {
    await expect(seeded().qbd.salesOrders.retrieve("nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("updates with the correct revision and bumps it", async () => {
    const so = seeded().qbd.salesOrders;
    const updated = await so.update("so-1", { revisionNumber: "1", memo: "picked" });
    expect(updated.memo).toBe("picked");
    expect(updated.revisionNumber).toBe("2");
  });

  it("rejects an update with a stale revision as a 3200", async () => {
    const so = seeded().qbd.salesOrders;
    const err = await so
      .update("so-1", { revisionNumber: "0", memo: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MockStaleRevisionError);
    expect(isStaleRevisionError(err)).toBe(true);
  });

  it("creates an order with revision 1", async () => {
    const so = await seeded().qbd.salesOrders.create({ refNumber: "SO-2" });
    expect(so.revisionNumber).toBe("1");
    expect(so.refNumber).toBe("SO-2");
  });

  it("lists seeded and created orders", async () => {
    const c = seeded();
    await c.qbd.salesOrders.create({ refNumber: "SO-2" });
    const page = await c.qbd.salesOrders.list();
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });
});

describe("armStaleRevision pairs with withStaleRevisionRetry", () => {
  it("recovers from a simulated concurrent edit", async () => {
    const so = seeded().qbd.salesOrders;
    so.armStaleRevision("so-1"); // next update throws 3200, revision advances to "2"

    let conflicts = 0;
    const updated = await withStaleRevisionRetry("1", {
      write: (rev) => so.update("so-1", { revisionNumber: rev, memo: "synced" }),
      refreshRevision: async () => (await so.retrieve("so-1")).revisionNumber,
      onConflict: () => conflicts++,
    });

    expect(conflicts).toBe(1);
    expect(updated.memo).toBe("synced");
    expect(updated.revisionNumber).toBe("3"); // 1 → (armed bump) 2 → (successful write) 3
  });
});
