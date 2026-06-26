import { describe, expect, it, vi } from "vitest";
import {
  isStaleRevisionError,
  unwrapConductorError,
  withStaleRevisionRetry,
} from "../src/stale-revision";

// Shapes mirror what conductor-node throws: body on `.error`, envelope under
// a further `.error` key (`err.error.error`).
function sdkError(body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.message ?? "api error")), {
    status: body.httpStatusCode ?? 502,
    error: { error: body },
  });
}

describe("isStaleRevisionError", () => {
  it("detects integrationCode 3200", () => {
    const err = sdkError({
      type: "INTEGRATION_ERROR",
      code: "QBD_REQUEST_ERROR",
      integrationCode: "3200",
      message: 'The provided revision number (edit sequence) "1" is out-of-date.',
    });
    expect(isStaleRevisionError(err)).toBe(true);
  });

  it("detects edit-sequence message even when integrationCode is missing", () => {
    const err = sdkError({
      code: "QBD_REQUEST_ERROR",
      message: 'The provided edit sequence "1" is out-of-date.',
    });
    expect(isStaleRevisionError(err)).toBe(true);
  });

  it("matches a one-level error shape (err.error)", () => {
    const err = Object.assign(new Error("boom"), {
      error: { code: "QBD_REQUEST_ERROR", integrationCode: "3200" },
    });
    expect(isStaleRevisionError(err)).toBe(true);
  });

  it("falls back to the raw message when there is no envelope", () => {
    expect(
      isStaleRevisionError(new Error('revision number "7" is out-of-date'))
    ).toBe(true);
  });

  it("is false for unrelated Conductor errors", () => {
    expect(
      isStaleRevisionError(
        sdkError({ code: "QBD_CONNECTION_ERROR", message: "connection not active" })
      )
    ).toBe(false);
  });

  it("is false for non-errors", () => {
    expect(isStaleRevisionError(null)).toBe(false);
    expect(isStaleRevisionError(undefined)).toBe(false);
    expect(isStaleRevisionError({})).toBe(false);
    expect(isStaleRevisionError("ok")).toBe(false);
  });
});

describe("unwrapConductorError", () => {
  it("returns the nested envelope", () => {
    const body = { code: "QBD_REQUEST_ERROR", integrationCode: "3200" };
    expect(unwrapConductorError(sdkError(body))).toMatchObject(body);
  });

  it("returns null when nothing recognizable is present", () => {
    expect(unwrapConductorError(new Error("plain"))).toBeNull();
  });
});

describe("withStaleRevisionRetry", () => {
  it("returns immediately on success without refreshing", async () => {
    const refreshRevision = vi.fn();
    const result = await withStaleRevisionRetry("1", {
      write: async (rev) => `wrote@${rev}`,
      refreshRevision,
    });
    expect(result).toBe("wrote@1");
    expect(refreshRevision).not.toHaveBeenCalled();
  });

  it("refreshes the revision and replays after a stale conflict", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(sdkError({ integrationCode: "3200", message: "out-of-date" }))
      .mockImplementation(async (rev: string) => `wrote@${rev}`);
    const onConflict = vi.fn();

    const result = await withStaleRevisionRetry("1", {
      write,
      refreshRevision: async () => "9",
      onConflict,
    });

    expect(result).toBe("wrote@9");
    expect(write).toHaveBeenCalledTimes(2);
    expect(onConflict).toHaveBeenCalledWith(1);
  });

  it("rethrows non-stale errors without retrying", async () => {
    const write = vi.fn().mockRejectedValue(sdkError({ code: "QBD_CONNECTION_ERROR" }));
    const refreshRevision = vi.fn();
    await expect(
      withStaleRevisionRetry("1", { write, refreshRevision })
    ).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(refreshRevision).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries conflicts and rethrows the last error", async () => {
    const write = vi.fn().mockRejectedValue(sdkError({ integrationCode: "3200" }));
    await expect(
      withStaleRevisionRetry("1", {
        write,
        refreshRevision: async () => "2",
        maxRetries: 2,
      })
    ).rejects.toMatchObject({ error: { error: { integrationCode: "3200" } } });
    expect(write).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
