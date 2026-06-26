import { describe, expect, it } from "vitest";
import { expBackoff } from "../src/sync/backoff";

describe("expBackoff", () => {
  it("grows exponentially from the base", () => {
    expect(expBackoff(1, { baseMs: 1000, factor: 2 })).toBe(1000);
    expect(expBackoff(2, { baseMs: 1000, factor: 2 })).toBe(2000);
    expect(expBackoff(3, { baseMs: 1000, factor: 2 })).toBe(4000);
  });

  it("clamps to maxMs", () => {
    expect(expBackoff(20, { baseMs: 1000, factor: 2, maxMs: 5000 })).toBe(5000);
  });

  it("treats attempt < 1 as the first attempt", () => {
    expect(expBackoff(0, { baseMs: 1000 })).toBe(1000);
  });
});
