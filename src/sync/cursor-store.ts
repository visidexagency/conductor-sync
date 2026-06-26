// Persistence contract for incremental sync watermarks. Implement it against
// your own database (a single row per key holding an ISO timestamp); an
// in-memory version is provided for tests and local dev.

export interface CursorStore {
  /** Return the stored watermark for `key`, or null if never synced. */
  get(key: string): Promise<string | null>;
  /** Persist the watermark for `key`. */
  set(key: string, cursorISO: string): Promise<void>;
}

export class InMemoryCursorStore implements CursorStore {
  private readonly map = new Map<string, string>();
  constructor(initial?: Record<string, string>) {
    for (const [k, v] of Object.entries(initial ?? {})) this.map.set(k, v);
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, cursorISO: string): Promise<void> {
    this.map.set(key, cursorISO);
  }
}
