// Adaptive bounded-concurrency limiter with slow-start + Retry-After rate cap.
//
// Replaces a fixed p-limit during real sync. Behaviour:
//  - Starts at capacity = 1 (slow-start) and doubles every N successful runs
//    until reaching `max`. Avoids the cold-cliff problem where firing N
//    requests at sync start triggers a 429 wave the server then takes
//    minutes to forgive.
//  - On any 429: capacity halves immediately (floor 1) and resets the
//    success counter. We pull back hard so the server gets breathing room.
//  - When a 429 carries a Retry-After hint, that interval becomes a
//    *minimum inter-request spacing*: new requests can't fire until then.
//    Future 429s extend the window; otherwise it elapses naturally.
//
// Bench is intentionally NOT using this — bench wants to measure absolute
// burst tolerance at a fixed concurrency. Only the real sync benefits.

const DEFAULT_BUMP_EVERY_SUCCESSES = 50;

export interface AdaptiveLimiterOptions {
  max: number;
  slowStart?: boolean;
  bumpEverySuccesses?: number;
}

export class AdaptiveLimiter {
  private capacity: number;
  private readonly max: number;
  private readonly bumpThreshold: number;
  private successesSinceBump = 0;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private nextSendAtMs = 0;

  constructor(opts: AdaptiveLimiterOptions) {
    this.max = Math.max(1, opts.max);
    this.capacity = opts.slowStart === false ? this.max : 1;
    this.bumpThreshold = opts.bumpEverySuccesses ?? DEFAULT_BUMP_EVERY_SUCCESSES;
  }

  get currentCapacity(): number {
    return this.capacity;
  }

  get maxCapacity(): number {
    return this.max;
  }

  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Honour the inter-request gate: if a recent 429's Retry-After hasn't
      // fully elapsed, wait it out before starting this request.
      const now = Date.now();
      if (now < this.nextSendAtMs) {
        await new Promise<void>((r) => setTimeout(r, this.nextSendAtMs - now));
      }
      return await fn();
    } finally {
      this.release();
    }
  }

  reportSuccess(): void {
    if (this.capacity >= this.max) return;
    this.successesSinceBump++;
    if (this.successesSinceBump >= this.bumpThreshold) {
      this.successesSinceBump = 0;
      const prev = this.capacity;
      this.capacity = Math.min(this.max, this.capacity * 2);
      if (this.capacity > prev) this.tryWake();
    }
  }

  report429(retryAfterMs?: number): void {
    this.successesSinceBump = 0;
    this.capacity = Math.max(1, Math.floor(this.capacity / 2));
    if (retryAfterMs && retryAfterMs > 0) {
      this.nextSendAtMs = Math.max(this.nextSendAtMs, Date.now() + retryAfterMs);
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.capacity) {
      this.inFlight++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    this.tryWake();
  }

  private tryWake(): void {
    while (this.inFlight < this.capacity && this.waiters.length > 0) {
      const wake = this.waiters.shift()!;
      wake();
    }
  }
}
