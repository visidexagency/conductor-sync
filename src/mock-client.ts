// An in-memory mock of the conductor-node Sales Order surface for local dev
// and CI, build and test your QuickBooks Desktop integration without a live
// Conductor account, a Windows box, or the Web Connector.
//
// It mirrors `conductor.qbd.salesOrders.{list,retrieve,update,create}` and
// enforces real optimistic-concurrency: an update with a stale revisionNumber
// throws a 3200 error shaped exactly like Conductor's, so it round-trips with
// `isStaleRevisionError` / `withStaleRevisionRetry`. `armStaleRevision(id)`
// simulates a concurrent QuickBooks edit so you can test your conflict path.
//
// Scope: Sales Orders, the common write-back entity. The pattern extends to
// any QBD object, copy MockSalesOrdersResource for invoices, estimates, etc.

import type { ConductorErrorBody } from "./stale-revision";

export interface MockSalesOrderLine {
  id: string;
  objectType: "qbd_sales_order_line";
  item: { id: string; fullName: string } | null;
  description: string | null;
  quantity: number;
}

export interface MockSalesOrder {
  id: string;
  objectType: "qbd_sales_order";
  revisionNumber: string;
  refNumber: string | null;
  customer: { id: string; fullName: string };
  memo: string | null;
  transactionDate: string;
  createdAt: string;
  updatedAt: string;
  lines: MockSalesOrderLine[];
}

export interface MockUpdateBody {
  revisionNumber: string;
  memo?: string;
}

export interface MockCreateBody {
  refNumber?: string | null;
  customer?: { id: string; fullName: string };
  memo?: string | null;
  transactionDate?: string;
  lines?: MockSalesOrderLine[];
}

export interface MockListParams {
  updatedAfter?: string;
  cursor?: string;
  limit?: number;
}

export interface MockListResult {
  objectType: "list";
  url: string;
  data: MockSalesOrder[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** A 3200 stale-revision error, shaped like a thrown conductor-node APIError. */
export class MockStaleRevisionError extends Error {
  readonly status = 502;
  readonly error: { error: ConductorErrorBody };
  constructor(provided: string, current: string) {
    const message = `QBD Request Error (3200): The provided revision number (edit sequence) "${provided}" is out-of-date; the current value is "${current}".`;
    super(message);
    this.name = "MockStaleRevisionError";
    this.error = {
      error: {
        type: "INTEGRATION_ERROR",
        code: "QBD_REQUEST_ERROR",
        integrationCode: "3200",
        httpStatusCode: 502,
        message,
      },
    };
  }
}

/** A 404, shaped like a thrown conductor-node NotFoundError. */
export class MockNotFoundError extends Error {
  readonly status = 404;
  readonly error: { error: ConductorErrorBody };
  constructor(id: string) {
    const message = `Sales order "${id}" not found.`;
    super(message);
    this.name = "MockNotFoundError";
    this.error = {
      error: { type: "INVALID_REQUEST_ERROR", code: "RESOURCE_MISSING", httpStatusCode: 404, message },
    };
  }
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString().padStart(8, "0")}`;
}

function bumpRevision(rev: string): string {
  const n = Number.parseInt(rev, 10);
  return Number.isFinite(n) ? String(n + 1) : "2";
}

export class MockSalesOrdersResource {
  private readonly store = new Map<string, MockSalesOrder>();
  private readonly staleArmed = new Set<string>();
  private readonly now: () => string;

  constructor(opts: { seed?: MockSalesOrder[]; now?: () => string } = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    for (const so of opts.seed ?? []) this.store.set(so.id, { ...so });
  }

  /**
   * Arm a one-shot concurrent-edit simulation: the next `update` for `id` is
   * rejected with a 3200 and the stored revisionNumber advances behind the
   * caller's back, exactly what happens when an office user edits the record
   * between your read and your write. The retry then succeeds.
   */
  armStaleRevision(id: string): void {
    this.staleArmed.add(id);
  }

  async list(params: MockListParams = {}): Promise<MockListResult> {
    let rows = [...this.store.values()];
    if (params.updatedAfter) {
      rows = rows.filter((r) => r.updatedAt >= params.updatedAfter!);
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return {
      objectType: "list",
      url: "/quickbooks-desktop/sales-orders",
      data: rows,
      nextCursor: null,
      hasMore: false,
    };
  }

  async retrieve(id: string): Promise<MockSalesOrder> {
    const so = this.store.get(id);
    if (!so) throw new MockNotFoundError(id);
    return { ...so };
  }

  async update(id: string, body: MockUpdateBody): Promise<MockSalesOrder> {
    const so = this.store.get(id);
    if (!so) throw new MockNotFoundError(id);

    if (this.staleArmed.has(id)) {
      this.staleArmed.delete(id);
      const provided = body.revisionNumber;
      so.revisionNumber = bumpRevision(so.revisionNumber); // simulate the concurrent edit
      so.updatedAt = this.now();
      throw new MockStaleRevisionError(provided, so.revisionNumber);
    }

    if (body.revisionNumber !== so.revisionNumber) {
      throw new MockStaleRevisionError(body.revisionNumber, so.revisionNumber);
    }

    if (body.memo !== undefined) so.memo = body.memo;
    so.revisionNumber = bumpRevision(so.revisionNumber);
    so.updatedAt = this.now();
    return { ...so };
  }

  async create(body: MockCreateBody): Promise<MockSalesOrder> {
    const ts = this.now();
    const so: MockSalesOrder = {
      id: nextId("so"),
      objectType: "qbd_sales_order",
      revisionNumber: "1",
      refNumber: body.refNumber ?? null,
      customer: body.customer ?? { id: "cust-mock", fullName: "Mock Customer" },
      memo: body.memo ?? null,
      transactionDate: body.transactionDate ?? ts.slice(0, 10),
      createdAt: ts,
      updatedAt: ts,
      lines: body.lines ?? [],
    };
    this.store.set(so.id, so);
    return { ...so };
  }
}

export interface MockConductorOptions {
  /** Seed sales orders into the store. */
  salesOrders?: MockSalesOrder[];
  /** Override the clock (tests). Defaults to Date.now(). */
  now?: () => string;
}

/**
 * Drop-in stand-in for a conductor-node client, scoped to Sales Orders.
 * Access mirrors the real SDK: `conductor.qbd.salesOrders.update(...)`.
 */
export class MockConductor {
  readonly qbd: { salesOrders: MockSalesOrdersResource };
  constructor(opts: MockConductorOptions = {}) {
    this.qbd = {
      salesOrders: new MockSalesOrdersResource({ seed: opts.salesOrders, now: opts.now }),
    };
  }
}
