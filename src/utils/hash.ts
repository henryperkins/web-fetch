/**
 * Hashing utilities for content identification
 */

import { createHash } from 'crypto';

/**
 * Generate SHA-256 hash of content
 */
export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate a stable source ID from URL, date, and content hash
 */
export function generateSourceId(canonicalUrl: string, retrievedAt: Date, contentHash: string): string {
  // Use day-level granularity for retrieved_at to allow same-day caching
  const dayString = retrievedAt.toISOString().split('T')[0];
  const combined = `${canonicalUrl}|${dayString}|${contentHash}`;
  return sha256(combined).substring(0, 16);
}

/**
 * Generate a block ID
 */
export function generateBlockId(index: number): string {
  return `b${index}`;
}

/**
 * Generate a chunk ID
 */
export function generateChunkId(sourceId: string, index: number): string {
  return `${sourceId}:c${index}`;
}
