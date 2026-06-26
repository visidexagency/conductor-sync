import { describe, expect, it } from "vitest";
import { InMemoryCursorStore } from "../src/sync/cursor-store";
import { runIncrementalSync } from "../src/sync/incremental-sync";

interface Rec {
  id: string;
  updatedAt: string;
}

const recs: Rec[] = [
  { id: "a", updatedAt: "2026-06-01T10:00:00.000Z" },
  { id: "b", updatedAt: "2026-06-02T10:00:00.000Z" },
  { id: "c", updatedAt: "2026-06-03T10:00:00.000Z" },
];

describe("runIncrementalSync", () => {
  it("processes all records and advances the cursor to the latest updatedAt", async () => {
    const cursorStore = new InMemoryCursorStore();
    const seen: string[] = [];

    const result = await runIncrementalSync<Rec>({
      key: "so",
      cursorStore,
      listUpdated: async () => recs,
      getUpdatedAt: (r) => r.updatedAt,
      onRecord: async (r) => {
        seen.push(r.id);
      },
    });

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result.processed).toBe(3);
    expect(result.cursor).toBe("2026-06-03T10:00:00.000Z");
    expect(await cursorStore.get("so")).toBe("2026-06-03T10:00:00.000Z");
  });

  it("passes the stored cursor (minus overlap) as the since filter", async () => {
    const cursorStore = new InMemoryCursorStore({ so: "2026-06-02T10:00:00.000Z" });
    let sinceSeen: string | null = "unset";

    await runIncrementalSync<Rec>({
      key: "so",
      cursorStore,
      listUpdated: async (since) => {
        sinceSeen = since;
        return [];
      },
      getUpdatedAt: (r) => r.updatedAt,
      onRecord: async () => {},
      overlapMs: 60_000,
    });

    expect(sinceSeen).toBe("2026-06-02T09:59:00.000Z"); // 1 min lookback
  });

  it("persists progress up to the last success when a handler throws", async () => {
    const cursorStore = new InMemoryCursorStore();
    const seen: string[] = [];

    await expect(
      runIncrementalSync<Rec>({
        key: "so",
        cursorStore,
        listUpdated: async () => recs,
        getUpdatedAt: (r) => r.updatedAt,
        onRecord: async (r) => {
          if (r.id === "c") throw new Error("boom");
          seen.push(r.id);
        },
      })
    ).rejects.toThrow("boom");

    expect(seen).toEqual(["a", "b"]);
    // Cursor advanced to b (last success), so c is retried next run, not skipped.
    expect(await cursorStore.get("so")).toBe("2026-06-02T10:00:00.000Z");
  });

  it("does not stamp a cursor when the first record fails on a first-ever run", async () => {
    const cursorStore = new InMemoryCursorStore();

    await expect(
      runIncrementalSync<Rec>({
        key: "so",
        cursorStore,
        listUpdated: async () => recs,
        getUpdatedAt: (r) => r.updatedAt,
        onRecord: async () => {
          throw new Error("boom");
        },
        now: () => Date.parse("2026-06-10T00:00:00.000Z"),
      })
    ).rejects.toThrow("boom");

    expect(await cursorStore.get("so")).toBeNull(); // nothing skipped on retry
  });

  it("stamps the cursor to now on a first-ever empty run", async () => {
    const cursorStore = new InMemoryCursorStore();
    const result = await runIncrementalSync<Rec>({
      key: "so",
      cursorStore,
      listUpdated: async () => [],
      getUpdatedAt: (r) => r.updatedAt,
      onRecord: async () => {},
      now: () => Date.parse("2026-06-10T00:00:00.000Z"),
    });
    expect(result.cursor).toBe("2026-06-10T00:00:00.000Z");
  });

  it("applies deletions after updates", async () => {
    const cursorStore = new InMemoryCursorStore();
    const deleted: string[] = [];

    const result = await runIncrementalSync<Rec, { id: string; deletedAt: string }>({
      key: "so",
      cursorStore,
      listUpdated: async () => [recs[0]!],
      getUpdatedAt: (r) => r.updatedAt,
      onRecord: async () => {},
      listDeleted: async () => [{ id: "z", deletedAt: "2026-06-05T10:00:00.000Z" }],
      getDeletedAt: (d) => d.deletedAt,
      onDelete: async (d) => {
        deleted.push(d.id);
      },
    });

    expect(deleted).toEqual(["z"]);
    expect(result.deleted).toBe(1);
    expect(result.cursor).toBe("2026-06-05T10:00:00.000Z"); // max of updated + deleted
  });
});
