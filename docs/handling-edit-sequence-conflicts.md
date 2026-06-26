# Handling edit-sequence conflicts (QBD error 3200)

> Draft written to be dropped into Conductor's docs (e.g. under **Usage**).
> Vendor-neutral and self-contained, it teaches the pattern with plain
> `conductor-node`; the optional helper at the end is a reference only.

QuickBooks Desktop uses **optimistic concurrency** to prevent two writers from silently clobbering each other. Every record carries an *edit sequence*, which Conductor exposes as `revisionNumber`. When you update a record, you must send the `revisionNumber` you last read. If the record changed in between (an office user edited it in QuickBooks, or another integration wrote to it), QuickBooks rejects your write:

```
type:            INTEGRATION_ERROR
code:            QBD_REQUEST_ERROR
integrationCode: "3200"
httpStatusCode:  502
message:         QBD Request Error (3200): The provided revision number
                 (edit sequence) "1493020304" is out-of-date.
```

This is expected and recoverable, not a bug in your code. It happens most often when your sync runs while staff are working in the company file.

## The fix: refetch, then replay

The resolution is always the same three steps:

1. Re-fetch the record to read its **current** `revisionNumber`.
2. Re-apply your change on top of the fresh record.
3. Retry the update with the current `revisionNumber`.

```ts
import Conductor, { APIError as ConductorError } from "conductor-node";

const conductor = new Conductor({ apiKey: process.env.CONDUCTOR_SECRET_KEY });
const conductorEndUserId = process.env.CONDUCTOR_END_USER_ID!;

async function updateMemoWithRetry(id: string, memo: string, maxRetries = 3) {
  let current = await conductor.qbd.salesOrders.retrieve(id, { conductorEndUserId });

  for (let attempt = 0; ; attempt++) {
    try {
      return await conductor.qbd.salesOrders.update(
        id,
        { conductorEndUserId, revisionNumber: current.revisionNumber, memo },
        { maxRetries: 0 } // a 3200 is a 502; SDK retries replay the stale revision and waste attempts
      );
    } catch (err) {
      if (attempt >= maxRetries || !isStaleRevision(err)) throw err;
      // Someone changed the record between our read and write, refetch and replay.
      current = await conductor.qbd.salesOrders.retrieve(id, { conductorEndUserId });
    }
  }
}
```

## Detecting the conflict

Match on `integrationCode === "3200"`, the precise QBD signal. As a fallback (in case the envelope is incomplete), check the error code and message text:

```ts
function isStaleRevision(err: unknown): boolean {
  const body = (err as any)?.error?.error; // conductor-node nests the envelope here
  if (body?.integrationCode === "3200") return true;
  if (body?.code === "QBD_REQUEST_ERROR" || body?.code === "INVALID_REQUEST_ERROR") {
    return /edit.?sequence|revision number/i.test(body.message ?? "");
  }
  return false;
}
```

## Guidelines

- **Always read the `revisionNumber` immediately before writing.** The longer the gap between read and write, the more likely a conflict.
- **Cap your retries** (3 is plenty). A persistent 3200 across several refetches usually means two systems are fighting over the same record; surface it for a human.
- **Re-apply your change against the fresh record,** not a stale copy, so you don't overwrite a field someone else just changed.
- **Pass `{ maxRetries: 0 }` on the write.** A 3200 comes back as an HTTP 502, which falls under the SDK's default retry-on-5xx rule, and the SDK replays the *same* request body on retry (it never refetches the revision). Disabling retries on this call keeps it from replaying the stale `revisionNumber`. Do the refetch yourself.
- **Treat 3200 as transient** in any durable queue / retry classifier; it succeeds on retry by design.

## Reference implementation

A small open-source helper packages this loop (plus an offline mock that reproduces 3200 for testing): [`conductor-sync`](https://github.com/visidexagency/conductor-sync).

```ts
import { withStaleRevisionRetry } from "conductor-sync";

const updated = await withStaleRevisionRetry(salesOrder.revisionNumber, {
  write: (revisionNumber) =>
    conductor.qbd.salesOrders.update(id, { conductorEndUserId, revisionNumber, memo }, { maxRetries: 0 }),
  refreshRevision: async () =>
    (await conductor.qbd.salesOrders.retrieve(id, { conductorEndUserId })).revisionNumber,
});
```
