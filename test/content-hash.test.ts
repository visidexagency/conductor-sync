import { describe, expect, it } from "vitest";
import { stableHash } from "../src/content-hash";

describe("stableHash", () => {
  it("ignores object key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("ignores key order in nested objects", () => {
    expect(stableHash({ x: { a: 1, b: [1, 2] } })).toBe(
      stableHash({ x: { b: [1, 2], a: 1 } })
    );
  });

  it("changes when content changes", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it("keeps array order significant", () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it("handles primitives and null, and distinguishes types", () => {
    expect(stableHash("x")).toBe(stableHash("x"));
    expect(stableHash(null)).toBe(stableHash(null));
    expect(stableHash(1)).not.toBe(stableHash("1"));
  });
});
