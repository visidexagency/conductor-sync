import { describe, expect, it } from "vitest";
import { InMemoryQueueStore, processQueue } from "../src/sync/queue";

function staleError() {
  return Object.assign(new Error("3200"), {
    status: 502,
    error: { error: { integrationCode: "3200" } },
  });
}
function permanentError() {
  return Object.assign(new Error("bad"), {
    status: 400,
    error: { error: { code: "INVALID_REQUEST_ERROR", message: "bad field" } },
  });
}

describe("processQueue", () => {
  it("completes successful jobs", async () => {
    const store = new InMemoryQueueStore<string>();
    store.enqueue("a");
    store.enqueue("b");
    const sent: string[] = [];

    const res = await processQueue<string, void>({
      store,
      send: async (payload) => {
        sent.push(payload);
      },
    });

    expect(sent).toEqual(["a", "b"]);
    expect(res.succeeded).toBe(2);
    expect(store.all().every((j) => j.status === "done")).toBe(true);
  });

  it("reschedules a transient failure with backoff into the future", async () => {
    const store = new InMemoryQueueStore<string>();
    const job = store.enqueue("a");

    const res = await processQueue<string, void>({
      store,
      now: () => 1000,
      backoff: () => 5000,
      send: async () => {
        throw staleError();
      },
    });

    expect(res.retried).toBe(1);
    const after = store.all().find((j) => j.id === job.id)!;
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(1);
    expect(after.nextRunAt).toBe(6000); // now + backoff
  });

  it("dead-letters a permanent failure immediately", async () => {
    const store = new InMemoryQueueStore<string>();
    const job = store.enqueue("a");

    const res = await processQueue<string, void>({
      store,
      send: async () => {
        throw permanentError();
      },
    });

    expect(res.deadLettered).toBe(1);
    expect(store.all().find((j) => j.id === job.id)!.status).toBe("dead");
  });

  it("dead-letters after exhausting maxAttempts", async () => {
    const store = new InMemoryQueueStore<string>();
    store.enqueue("a");
    let now = 0;

    // maxAttempts=2: first run reschedules (attempt 1), second dead-letters.
    const opts = {
      store,
      maxAttempts: 2,
      backoff: () => 0,
      now: () => now,
      send: async () => {
        throw staleError();
      },
    };

    const first = await processQueue<string, void>(opts);
    expect(first.retried).toBe(1);

    now = 100; // let the rescheduled job become eligible
    const second = await processQueue<string, void>(opts);
    expect(second.deadLettered).toBe(1);
    expect(store.all()[0]!.status).toBe("dead");
  });

  it("does not block on a job scheduled for the future (head-of-line)", async () => {
    const store = new InMemoryQueueStore<string>();
    const blocked = store.enqueue("blocked");
    // Manually push it into the future as if a prior retry rescheduled it.
    await store.reschedule(blocked.id, 10_000, 1);
    store.enqueue("ready");

    const sent: string[] = [];
    await processQueue<string, void>({
      store,
      now: () => 0,
      send: async (p) => {
        sent.push(p);
      },
    });

    expect(sent).toEqual(["ready"]); // future job skipped, ready job processed
  });

  it("respects the max drain budget", async () => {
    const store = new InMemoryQueueStore<string>();
    store.enqueue("a");
    store.enqueue("b");
    store.enqueue("c");
    let count = 0;

    await processQueue<string, void>({
      store,
      max: 2,
      send: async () => {
        count++;
      },
    });

    expect(count).toBe(2);
  });
});
