/**
 * robots.txt Parser and Checker
 *
 * Respects site crawling policies as configured.
 */

import { request } from 'undici';
import { getRobotsCache } from '../utils/cache.js';
import type { RobotsResult } from '../types.js';

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface ParsedRobots {
  rules: RobotsRule[];
  crawlDelay?: number;
}

// User agent to match in robots.txt
const DEFAULT_BOT_USER_AGENTS = ['web-fetch-mcp', 'webfetch', '*'];

function normalizeUserAgent(userAgent?: string): string {
  if (!userAgent) return 'web-fetch-mcp';
  const token = userAgent.trim().split(/[\s/]+/)[0];
  return (token || userAgent).toLowerCase();
}

function buildUserAgentList(userAgent?: string): string[] {
  const normalized = normalizeUserAgent(userAgent);
  const aliases = new Set<string>([normalized, userAgent?.toLowerCase() ?? normalized]);
  DEFAULT_BOT_USER_AGENTS.forEach(ua => aliases.add(ua));
  return Array.from(aliases);
}

function buildCacheKey(origin: string, userAgent?: string): string {
  return `${origin.toLowerCase()}::${normalizeUserAgent(userAgent)}`;
}

const crawlDelayTracker = new Map<string, number>();

export async function applyCrawlDelay(
  origin: string,
  crawlDelay?: number,
  userAgent?: string
): Promise<void> {
  if (!crawlDelay || crawlDelay <= 0) return;

  const key = buildCacheKey(origin, userAgent);
  const now = Date.now();
  const earliestNext = crawlDelayTracker.get(key);
  const waitMs = earliestNext ? Math.max(0, earliestNext + crawlDelay * 1000 - now) : 0;

  if (waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  crawlDelayTracker.set(key, Date.now());
}

/**
 * Parse robots.txt content
 */
function parseRobotsTxt(content: string, userAgents: string[]): ParsedRobots {
  const lines = content.split('\n').map(l => l.trim());
  const rules: RobotsRule[] = [];
  let crawlDelay: number | undefined;
  let inMatchingBlock = false;
  let foundAnyBlock = false;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const directive = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    if (directive === 'user-agent') {
      foundAnyBlock = true;
      const ua = value.toLowerCase();
      inMatchingBlock = userAgents.some(ourUa =>
        ua === ourUa.toLowerCase() || ua === '*'
      );
    } else if (inMatchingBlock) {
      if (directive === 'disallow' && value) {
        rules.push({ allow: false, path: value });
      } else if (directive === 'allow' && value) {
        rules.push({ allow: true, path: value });
      } else if (directive === 'crawl-delay') {
        const delay = parseFloat(value);
        if (!isNaN(delay) && delay > 0) {
          crawlDelay = delay;
        }
      }
    }
  }

  // If no matching block found, default to allow
  if (!foundAnyBlock) {
    return { rules: [], crawlDelay: undefined };
  }

  return { rules, crawlDelay };
}

/**
 * Check if a path matches a robots.txt pattern
 */
function pathMatches(path: string, pattern: string): boolean {
  // Handle wildcards
  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}`);
    return regex.test(path);
  }

  // Handle end-of-url marker
  if (pattern.endsWith('$')) {
    return path === pattern.slice(0, -1);
  }

  // Simple prefix match
  return path.startsWith(pattern);
}

/**
 * Check if a URL path is allowed by robots.txt rules
 */
function isPathAllowed(path: string, rules: RobotsRule[]): boolean {
  // Find all matching rules
  const matchingRules = rules.filter(r => pathMatches(path, r.path));

  if (matchingRules.length === 0) {
    return true; // No rules = allowed
  }

  // Most specific rule wins (longest path)
  // If tie, allow beats disallow
  matchingRules.sort((a, b) => {
    const lenDiff = b.path.length - a.path.length;
    if (lenDiff !== 0) return lenDiff;
    return a.allow ? -1 : 1;
  });

  return matchingRules[0]!.allow;
}

/**
 * Fetch and parse robots.txt for a host
 */
export async function fetchRobotsTxt(
  origin: string,
  options: { timeoutMs?: number; userAgent?: string } = {}
): Promise<ParsedRobots> {
  const { timeoutMs = 10000, userAgent = 'web-fetch-mcp/1.0' } = options;
  const userAgents = buildUserAgentList(userAgent);

  try {
    const robotsUrl = `${origin}/robots.txt`;
    const response = await request(robotsUrl, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    if (response.statusCode !== 200) {
      // No robots.txt or error = allow all
      await response.body.dump();
      return { rules: [], crawlDelay: undefined };
    }

    const content = await response.body.text();
    return parseRobotsTxt(content, userAgents);
  } catch {
    // Network error = allow all
    return { rules: [], crawlDelay: undefined };
  }
}

/**
 * Check if a URL is allowed by robots.txt
 */
export async function checkRobots(
  url: string,
  options: { timeoutMs?: number; userAgent?: string } = {}
): Promise<RobotsResult> {
  const cache = getRobotsCache();

  try {
    const urlObj = new URL(url);
    const origin = urlObj.origin;
    const path = urlObj.pathname + urlObj.search;
    const cacheKey = buildCacheKey(origin, options.userAgent);

    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        allowed: isPathAllowed(path, cached.rules),
        crawlDelay: cached.crawlDelay,
      };
    }

    const robots = await fetchRobotsTxt(origin, options);
    cache.set(cacheKey, robots);

    return {
      allowed: isPathAllowed(path, robots.rules),
      crawlDelay: robots.crawlDelay,
    };
  } catch {
    // On error, assume allowed
    return { allowed: true };
  }
}

export function resetRobotsState(): void {
  getRobotsCache().clear();
  crawlDelayTracker.clear();
}
