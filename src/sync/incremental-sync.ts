// Incremental change-data-capture on top of conductor-node.
//
// Conductor gives you the primitives, `updatedAfter` filters, cursor
// pagination, and the deleted-transactions / deleted-list-objects endpoints, // but no watermark persistence or resumable change feed. Every integrator
// rebuilds that. This runner owns the watermark: it pulls everything changed
// since the last successful sync, hands each record to your handler, and
// advances the cursor to the last record it processed *successfully*.
//
// Durability: records are processed in ascending updatedAt order and the
// watermark advances per record, so if a handler throws mid-batch the cursor
// is persisted up to the last success and the next run resumes from there, // nothing is skipped. Pass `overlapMs` to re-scan a short window each run as
// insurance against records sharing a timestamp (make your handler idempotent).
//
// Intended for incremental deltas, which are small. For a first full backfill,
// run it once with no stored cursor; it collects and sorts the batch in memory.

import type { CursorStore } from "./cursor-store";

export interface IncrementalSyncOptions<TRecord, TDeleted = unknown> {
  /** Watermark namespace, e.g. "sales-orders". */
  key: string;
  cursorStore: CursorStore;

  /** Fetch records updated at/after `sinceISO` (null = all-time / first run). */
  listUpdated: (sinceISO: string | null) => AsyncIterable<TRecord> | Promise<Iterable<TRecord>>;
  /** Extract a record's updatedAt as an ISO string. */
  getUpdatedAt: (record: TRecord) => string;
  /** Handle one changed record. Throwing stops the run (cursor keeps progress). */
  onRecord: (record: TRecord) => Promise<void>;

  /** Optional: fetch deletions since `sinceISO` (deleted-transactions feed). */
  listDeleted?: (sinceISO: string | null) => AsyncIterable<TDeleted> | Promise<Iterable<TDeleted>>;
  /** Extract a deletion's deletedAt as an ISO string. */
  getDeletedAt?: (deleted: TDeleted) => string;
  /** Handle one deletion. */
  onDelete?: (deleted: TDeleted) => Promise<void>;

  /** Re-scan window (ms) subtracted from the stored cursor each run. Default 0. */
  overlapMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface IncrementalSyncResult {
  processed: number;
  deleted: number;
  /** Cursor persisted at the end of the run (or null if nothing has synced). */
  cursor: string | null;
}

function isAsyncIterable<T>(v: unknown): v is AsyncIterable<T> {
  return v != null && typeof (v as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

async function collect<T>(
  src: AsyncIterable<T> | Promise<Iterable<T>> | Iterable<T>
): Promise<T[]> {
  const out: T[] = [];
  // A conductor-node PagePromise is BOTH a thenable and directly
  // async-iterable. Iterate it directly so pagination is followed, awaiting it
  // first would resolve only the first page.
  if (isAsyncIterable<T>(src)) {
    for await (const item of src) out.push(item);
    return out;
  }
  const resolved = await src;
  if (isAsyncIterable<T>(resolved)) {
    for await (const item of resolved) out.push(item);
  } else {
    for (const item of resolved) out.push(item);
  }
  return out;
}

function maxIso(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

export async function runIncrementalSync<TRecord, TDeleted = unknown>(
  opts: IncrementalSyncOptions<TRecord, TDeleted>
): Promise<IncrementalSyncResult> {
  const stored = await opts.cursorStore.get(opts.key);
  const overlapMs = opts.overlapMs ?? 0;
  const now = opts.now ?? (() => Date.now());

  let sinceISO: string | null = stored;
  if (stored && overlapMs > 0) {
    sinceISO = new Date(Math.max(0, Date.parse(stored) - overlapMs)).toISOString();
  }

  let watermark = stored;
  let processed = 0;
  let deleted = 0;
  let completed = false;

  // Updated records, ascending updatedAt so the watermark advances safely.
  const records = await collect(opts.listUpdated(sinceISO));
  records.sort((a, b) => opts.getUpdatedAt(a).localeCompare(opts.getUpdatedAt(b)));

  try {
    for (const record of records) {
      await opts.onRecord(record);
      watermark = maxIso(watermark, opts.getUpdatedAt(record));
      processed++;
    }

    // Deletions, only after updates succeed, so a delete can't outrun the
    // watermark and get skipped on the next run.
    if (opts.listDeleted && opts.onDelete && opts.getDeletedAt) {
      const deletions = await collect(opts.listDeleted(sinceISO));
      deletions.sort((a, b) => opts.getDeletedAt!(a).localeCompare(opts.getDeletedAt!(b)));
      for (const d of deletions) {
        await opts.onDelete(d);
        watermark = maxIso(watermark, opts.getDeletedAt(d));
        deleted++;
      }
    }
    completed = true;
  } finally {
    // Persist whatever progress we made, even if a handler threw, the next
    // run resumes from here instead of replaying everything.
    if (watermark && watermark !== stored) {
      await opts.cursorStore.set(opts.key, watermark);
    } else if (completed && !watermark) {
      // First-ever run that completed with an empty result set: stamp the
      // cursor to "now" so subsequent runs query a bounded window rather than
      // all-time. Only when no handler threw, otherwise we'd skip records.
      const stamp = new Date(now()).toISOString();
      await opts.cursorStore.set(opts.key, stamp);
      watermark = stamp;
    }
  }

  return { processed, deleted, cursor: watermark };
}
