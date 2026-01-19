/**
 * Simple in-memory cache with TTL
 */

import type { RawFetchResult } from '../types.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;
  private maxSize: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: { defaultTtlMs?: number; maxSize?: number; cleanupIntervalMs?: number } = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxSize = options.maxSize ?? 1000;

    // Start periodic cleanup
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 1000; // 1 minute
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  /**
   * Get a value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: string, value: T, ttlMs?: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a key from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Stop the cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }

  /**
   * Remove expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Evict the oldest entry (by expiration time, which approximates insertion order)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestExpires = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < oldestExpires) {
        oldestExpires = entry.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// Singleton fetch cache
let fetchCache: SimpleCache<RawFetchResult> | null = null;

export function getFetchCache(ttlMs: number): SimpleCache<RawFetchResult> {
  if (!fetchCache) {
    fetchCache = new SimpleCache({ defaultTtlMs: ttlMs, maxSize: 100 });
  }
  return fetchCache;
}

// Robots.txt cache
let robotsCache: SimpleCache<{ rules: { allow: boolean; path: string }[]; crawlDelay?: number }> | null = null;

export function getRobotsCache(): SimpleCache<{ rules: { allow: boolean; path: string }[]; crawlDelay?: number }> {
  if (!robotsCache) {
    robotsCache = new SimpleCache({ defaultTtlMs: 15 * 60 * 1000, maxSize: 500 }); // 15 minute TTL
  }
  return robotsCache;
}
