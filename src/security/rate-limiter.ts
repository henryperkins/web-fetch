/**
 * Per-host rate limiting
 *
 * Implements a sliding window rate limiter to prevent
 * overwhelming individual hosts.
 */

interface RateLimitEntry {
  timestamps: number[];
  backoffUntil: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private maxRequestsPerMinute: number;
  private windowMs = 60 * 1000; // 1 minute
  private maxBackoffMs = 5 * 60 * 1000; // 5 minutes max backoff

  constructor(maxRequestsPerMinute: number = 60) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
  }

  /**
   * Check if a request to the host is allowed
   */
  canRequest(host: string): boolean {
    const entry = this.getEntry(host);
    const now = Date.now();

    // Check backoff
    if (now < entry.backoffUntil) {
      return false;
    }

    // Clean old timestamps
    this.cleanTimestamps(entry, now);

    return entry.timestamps.length < this.maxRequestsPerMinute;
  }

  /**
   * Record a request to a host
   */
  recordRequest(host: string): void {
    const entry = this.getEntry(host);
    const now = Date.now();

    this.cleanTimestamps(entry, now);
    entry.timestamps.push(now);
  }

  /**
   * Get wait time until next request is allowed (in ms)
   */
  getWaitTime(host: string): number {
    const entry = this.getEntry(host);
    const now = Date.now();

    // Check backoff
    if (now < entry.backoffUntil) {
      return entry.backoffUntil - now;
    }

    this.cleanTimestamps(entry, now);

    if (entry.timestamps.length < this.maxRequestsPerMinute) {
      return 0;
    }

    // Need to wait for oldest request to expire
    const oldestTimestamp = entry.timestamps[0];
    if (oldestTimestamp === undefined) return 0;
    return oldestTimestamp + this.windowMs - now;
  }

  /**
   * Record an error and apply exponential backoff
   */
  recordError(host: string, retryAfterSeconds?: number): void {
    const entry = this.getEntry(host);
    const now = Date.now();

    // Calculate backoff time
    let backoffMs: number;
    if (retryAfterSeconds !== undefined) {
      backoffMs = retryAfterSeconds * 1000;
    } else {
      // Exponential backoff based on recent errors
      const recentErrors = entry.timestamps.filter(t => now - t < this.windowMs).length;
      backoffMs = Math.min(
        this.maxBackoffMs,
        Math.pow(2, Math.min(recentErrors, 6)) * 1000 // 2^n seconds, max 64s, capped at maxBackoff
      );
    }

    entry.backoffUntil = now + backoffMs;
  }

  /**
   * Reset limits for a host
   */
  reset(host: string): void {
    this.limits.delete(host);
  }

  /**
   * Reset all limits
   */
  resetAll(): void {
    this.limits.clear();
  }

  /**
   * Get current state for debugging
   */
  getState(host: string): {
    requestsInWindow: number;
    backoffRemaining: number;
    waitTime: number;
  } {
    const entry = this.getEntry(host);
    const now = Date.now();

    this.cleanTimestamps(entry, now);

    return {
      requestsInWindow: entry.timestamps.length,
      backoffRemaining: Math.max(0, entry.backoffUntil - now),
      waitTime: this.getWaitTime(host),
    };
  }

  private getEntry(host: string): RateLimitEntry {
    let entry = this.limits.get(host);
    if (!entry) {
      entry = { timestamps: [], backoffUntil: 0 };
      this.limits.set(host, entry);
    }
    return entry;
  }

  private cleanTimestamps(entry: RateLimitEntry, now: number): void {
    const cutoff = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
  }
}

// Singleton rate limiter
let rateLimiter: RateLimiter | null = null;

export function getRateLimiter(maxRequestsPerMinute: number = 60): RateLimiter {
  if (!rateLimiter) {
    rateLimiter = new RateLimiter(maxRequestsPerMinute);
  }
  return rateLimiter;
}

/**
 * Wait until rate limit allows a request
 */
export async function waitForRateLimit(
  host: string,
  limiter: RateLimiter,
  maxWaitMs: number = 30000
): Promise<boolean> {
  const waitTime = limiter.getWaitTime(host);

  if (waitTime === 0) {
    return true;
  }

  if (waitTime > maxWaitMs) {
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, waitTime));
  return true;
}
