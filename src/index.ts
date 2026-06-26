// Write-back reliability
export {
  isStaleRevisionError,
  unwrapConductorError,
  withStaleRevisionRetry,
  type ConductorErrorBody,
  type StaleRevisionRetryOptions,
} from "./stale-revision";

export {
  classifyConductorError,
  type ConductorErrorClass,
} from "./classify";

// Sync engine
export { expBackoff, type BackoffOptions } from "./sync/backoff";
export { InMemoryCursorStore, type CursorStore } from "./sync/cursor-store";
export {
  runIncrementalSync,
  type IncrementalSyncOptions,
  type IncrementalSyncResult,
} from "./sync/incremental-sync";
export {
  processQueue,
  InMemoryQueueStore,
  type QueueStore,
  type QueueJob,
  type QueueJobStatus,
  type QueueOutcome,
  type ProcessQueueOptions,
  type ProcessQueueResult,
} from "./sync/queue";

// Offline testing
export {
  MockConductor,
  MockSalesOrdersResource,
  MockStaleRevisionError,
  MockNotFoundError,
  type MockConductorOptions,
  type MockSalesOrder,
  type MockSalesOrderLine,
  type MockUpdateBody,
  type MockCreateBody,
  type MockListParams,
  type MockListResult,
} from "./mock-client";
