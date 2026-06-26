// A durable outbound queue for QuickBooks Desktop write-back.
//
// QBD processes requests serially, so this runner is sequential by design, // it claims one job at a time, sends it, and on failure decides retry vs.
// dead-letter using the error classifier. Head-of-line safety: a job that
// fails permanently is dead-lettered (not left at the front blocking the
// queue), and a job awaiting retry is scheduled into the future so the run
// moves on to the next ready job.
//
// Persistence is yours, implement `QueueStore` against your DB. An in-memory
// store is provided for tests and local dev.

import { classifyConductorError, type ConductorErrorClass } from "../classify";
import { expBackoff, type BackoffOptions } from "./backoff";

export type QueueJobStatus = "ready" | "running" | "done" | "dead";

export interface QueueJob<TPayload = unknown> {
  id: string;
  payload: TPayload;
  /** Completed attempts so far. Starts at 0. */
  attempt: number;
  /** Epoch ms; the job is eligible when nextRunAt <= now. */
  nextRunAt: number;
  status: QueueJobStatus;
}

export interface QueueStore<TPayload = unknown> {
  /** Claim the oldest eligible job (status "ready", nextRunAt <= now), mark it
   *  "running", and return it, or null if none are ready. Must be atomic.
   *  `exclude` lists ids already handled in the current drain; skip them so a
   *  job rescheduled this run isn't re-attempted until the next run. */
  claimNext(now: number, exclude?: ReadonlySet<string>): Promise<QueueJob<TPayload> | null>;
  /** Mark a job done. */
  complete(id: string): Promise<void>;
  /** Return a job to "ready" with a future nextRunAt and incremented attempt. */
  reschedule(id: string, nextRunAt: number, attempt: number): Promise<void>;
  /** Mark a job dead (exhausted retries or permanent error). */
  deadLetter(id: string, reason: string): Promise<void>;
}

export type QueueOutcome<TPayload, TResult> =
  | { job: QueueJob<TPayload>; status: "success"; result: TResult }
  | { job: QueueJob<TPayload>; status: "retry"; error: unknown; nextRunAt: number }
  | { job: QueueJob<TPayload>; status: "dead"; error: unknown; reason: string };

export interface ProcessQueueOptions<TPayload, TResult> {
  store: QueueStore<TPayload>;
  /** Send one job to Conductor. */
  send: (payload: TPayload, job: QueueJob<TPayload>) => Promise<TResult>;
  /** Override the transient/permanent decision. Default: classifyConductorError. */
  classify?: (err: unknown) => ConductorErrorClass;
  /** Override the retry delay (ms) for a given upcoming attempt. */
  backoff?: (attempt: number) => number;
  backoffOptions?: BackoffOptions;
  /** Max total attempts before a transient failure is dead-lettered. Default 8. */
  maxAttempts?: number;
  /** Max jobs to process in this run (drain budget). Default: until empty. */
  max?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Observe each job's outcome. */
  onOutcome?: (outcome: QueueOutcome<TPayload, TResult>) => void;
}

export interface ProcessQueueResult {
  succeeded: number;
  retried: number;
  deadLettered: number;
}

/**
 * Drain ready jobs. Returns counts; per-job detail is available via onOutcome.
 */
export async function processQueue<TPayload, TResult>(
  opts: ProcessQueueOptions<TPayload, TResult>
): Promise<ProcessQueueResult> {
  const classify = opts.classify ?? classifyConductorError;
  const backoff =
    opts.backoff ?? ((attempt: number) => expBackoff(attempt, opts.backoffOptions));
  const maxAttempts = opts.maxAttempts ?? 8;
  const now = opts.now ?? (() => Date.now());
  const budget = opts.max ?? Infinity;

  const result: ProcessQueueResult = { succeeded: 0, retried: 0, deadLettered: 0 };
  const handled = new Set<string>();

  for (let n = 0; n < budget; n++) {
    const job = await opts.store.claimNext(now(), handled);
    if (!job) break;
    handled.add(job.id);

    try {
      const sent = await opts.send(job.payload, job);
      await opts.store.complete(job.id);
      result.succeeded++;
      opts.onOutcome?.({ job, status: "success", result: sent });
    } catch (error) {
      const attempt = job.attempt + 1;
      const permanent = classify(error) === "permanent";
      if (permanent || attempt >= maxAttempts) {
        const reason = permanent
          ? "permanent error"
          : `exhausted ${maxAttempts} attempts`;
        await opts.store.deadLetter(job.id, reason);
        result.deadLettered++;
        opts.onOutcome?.({ job, status: "dead", error, reason });
      } else {
        const nextRunAt = now() + backoff(attempt);
        await opts.store.reschedule(job.id, nextRunAt, attempt);
        result.retried++;
        opts.onOutcome?.({ job, status: "retry", error, nextRunAt });
      }
    }
  }

  return result;
}

// ── In-memory reference store ──────────────────────────────────────

export class InMemoryQueueStore<TPayload = unknown> implements QueueStore<TPayload> {
  private readonly jobs: QueueJob<TPayload>[] = [];
  private counter = 0;

  /** Test/dev helper, enqueue a payload, ready immediately. */
  enqueue(payload: TPayload, id?: string): QueueJob<TPayload> {
    this.counter += 1;
    const job: QueueJob<TPayload> = {
      id: id ?? `job-${this.counter}`,
      payload,
      attempt: 0,
      nextRunAt: 0,
      status: "ready",
    };
    this.jobs.push(job);
    return job;
  }

  /** Snapshot for assertions. */
  all(): ReadonlyArray<QueueJob<TPayload>> {
    return this.jobs;
  }

  async claimNext(
    now: number,
    exclude?: ReadonlySet<string>
  ): Promise<QueueJob<TPayload> | null> {
    const eligible = this.jobs
      .filter((j) => j.status === "ready" && j.nextRunAt <= now && !exclude?.has(j.id))
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
    const job = eligible[0];
    if (!job) return null;
    job.status = "running";
    return { ...job };
  }

  async complete(id: string): Promise<void> {
    this.mutate(id, (j) => {
      j.status = "done";
    });
  }

  async reschedule(id: string, nextRunAt: number, attempt: number): Promise<void> {
    this.mutate(id, (j) => {
      j.status = "ready";
      j.nextRunAt = nextRunAt;
      j.attempt = attempt;
    });
  }

  async deadLetter(id: string, _reason: string): Promise<void> {
    this.mutate(id, (j) => {
      j.status = "dead";
    });
  }

  private mutate(id: string, fn: (j: QueueJob<TPayload>) => void): void {
    const job = this.jobs.find((j) => j.id === id);
    if (job) fn(job);
  }
}
