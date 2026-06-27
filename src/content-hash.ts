import { createHash } from "node:crypto";

/**
 * Stable SHA-256 of a JSON-serializable value, with object keys sorted
 * recursively so field order doesn't change the result.
 *
 * Use it to skip no-op work: QuickBooks bumps `updatedAt` on cosmetic re-saves,
 * so an incremental pull can hand you a record that looks new but isn't. Hash
 * the fields you care about, compare against the hash you stored last time, and
 * skip when they match. Arrays stay order-sensitive; sort them yourself first if
 * their order is noise.
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}
