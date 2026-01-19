/**
 * SSRF (Server-Side Request Forgery) protection
 *
 * Prevents requests to:
 * - Localhost and loopback addresses
 * - Private IP ranges (RFC 1918)
 * - Link-local addresses
 * - Multicast addresses
 * - Special/reserved addresses
 */

import { promises as dns } from 'dns';

// IPv4 private/special ranges
const IPV4_BLOCKED_RANGES = [
  { start: '0.0.0.0', end: '0.255.255.255' },        // "This" network
  { start: '10.0.0.0', end: '10.255.255.255' },      // Private (Class A)
  { start: '100.64.0.0', end: '100.127.255.255' },   // Carrier-grade NAT
  { start: '127.0.0.0', end: '127.255.255.255' },    // Loopback
  { start: '169.254.0.0', end: '169.254.255.255' },  // Link-local
  { start: '172.16.0.0', end: '172.31.255.255' },    // Private (Class B)
  { start: '192.0.0.0', end: '192.0.0.255' },        // IETF Protocol Assignments
  { start: '192.0.2.0', end: '192.0.2.255' },        // Documentation (TEST-NET-1)
  { start: '192.88.99.0', end: '192.88.99.255' },    // 6to4 relay anycast
  { start: '192.168.0.0', end: '192.168.255.255' },  // Private (Class C)
  { start: '198.18.0.0', end: '198.19.255.255' },    // Benchmarking
  { start: '198.51.100.0', end: '198.51.100.255' },  // Documentation (TEST-NET-2)
  { start: '203.0.113.0', end: '203.0.113.255' },    // Documentation (TEST-NET-3)
  { start: '224.0.0.0', end: '239.255.255.255' },    // Multicast
  { start: '240.0.0.0', end: '255.255.255.254' },    // Reserved for future use
  { start: '255.255.255.255', end: '255.255.255.255' }, // Broadcast
];

// IPv6 blocked prefixes
const IPV6_BLOCKED_PREFIXES = [
  '::1',           // Loopback
  '::',            // Unspecified
  '::ffff:',       // IPv4-mapped (we'll check the embedded IPv4)
  'fe80:',         // Link-local
  'fc00:',         // Unique local (ULA)
  'fd00:',         // Unique local (ULA)
  'ff00:',         // Multicast
  '2001:db8:',     // Documentation
  '100::',         // Discard-only
  '64:ff9b::',     // IPv4/IPv6 translation (needs IPv4 check)
];

/**
 * Convert IPv4 string to number for range comparison
 */
function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/**
 * Check if an IPv4 address is in a blocked range
 */
function isBlockedIPv4(ip: string): boolean {
  try {
    const ipNum = ipv4ToNumber(ip);
    for (const range of IPV4_BLOCKED_RANGES) {
      const startNum = ipv4ToNumber(range.start);
      const endNum = ipv4ToNumber(range.end);
      if (ipNum >= startNum && ipNum <= endNum) {
        return true;
      }
    }
    return false;
  } catch {
    return true; // Invalid IPs are blocked
  }
}

/**
 * Check if an IPv6 address is blocked
 */
function isBlockedIPv6(ip: string): boolean {
  const normalizedIp = ip.toLowerCase();

  // Check blocked prefixes
  for (const prefix of IPV6_BLOCKED_PREFIXES) {
    if (normalizedIp.startsWith(prefix.toLowerCase())) {
      // Special handling for IPv4-mapped addresses
      if (prefix === '::ffff:') {
        const ipv4Part = normalizedIp.slice(7);
        if (ipv4Part.includes('.')) {
          return isBlockedIPv4(ipv4Part);
        }
      }
      return true;
    }
  }

  // Expand and check for loopback
  if (normalizedIp === '::1' || normalizedIp === '0:0:0:0:0:0:0:1') {
    return true;
  }

  return false;
}

/**
 * Check if an IP address (v4 or v6) is private/blocked
 */
export function isBlockedIP(ip: string): boolean {
  // Detect if IPv6
  if (ip.includes(':')) {
    return isBlockedIPv6(ip);
  }
  return isBlockedIPv4(ip);
}

/**
 * Resolve hostname and check if any resolved IP is blocked
 *
 * This prevents DNS rebinding attacks where a hostname initially resolves
 * to a public IP but then resolves to a private IP.
 */
export async function resolveAndValidate(
  hostname: string,
  blockPrivateIp: boolean = true
): Promise<{ valid: boolean; addresses: string[]; error?: string }> {
  // Check for IP address literals
  if (isIPAddress(hostname)) {
    if (blockPrivateIp && isBlockedIP(hostname)) {
      return {
        valid: false,
        addresses: [hostname],
        error: `IP address ${hostname} is blocked (private/reserved range)`,
      };
    }
    return { valid: true, addresses: [hostname] };
  }

  // Block localhost hostnames
  const lowercaseHostname = hostname.toLowerCase();
  if (lowercaseHostname === 'localhost' || lowercaseHostname.endsWith('.localhost')) {
    return {
      valid: false,
      addresses: [],
      error: 'localhost is blocked',
    };
  }

  // Resolve DNS (include AAAA records and hosts file entries)
  try {
    const records = await dns.lookup(hostname, { all: true });
    const addresses = records.map(record => record.address);

    if (addresses.length === 0) {
      return {
        valid: false,
        addresses: [],
        error: 'No DNS records found',
      };
    }

    if (blockPrivateIp) {
      for (const addr of addresses) {
        if (isBlockedIP(addr)) {
          return {
            valid: false,
            addresses,
            error: `Resolved IP ${addr} is blocked (private/reserved range)`,
          };
        }
      }
    }

    return { valid: true, addresses };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'DNS resolution failed';
    return {
      valid: false,
      addresses: [],
      error,
    };
  }
}

/**
 * Check if a string is an IP address (v4 or v6)
 */
function isIPAddress(str: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(str)) {
    const parts = str.split('.').map(p => parseInt(p, 10));
    return parts.every(p => p >= 0 && p <= 255);
  }

  // IPv6 pattern (simplified check)
  if (str.includes(':')) {
    // Basic IPv6 validation
    const parts = str.split(':');
    if (parts.length >= 2 && parts.length <= 8) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a URL for SSRF safety
 */
export async function validateUrlForSSRF(
  urlString: string,
  options: { blockPrivateIp?: boolean; allowlistDomains?: string[] } = {}
): Promise<{ valid: boolean; error?: string }> {
  const { blockPrivateIp = true, allowlistDomains = [] } = options;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }

  // Only allow http/https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      valid: false,
      error: `Protocol ${url.protocol} is not allowed. Only http:// and https:// are permitted.`,
    };
  }

  // Check allowlist if configured
  if (allowlistDomains.length > 0) {
    const hostname = url.hostname.toLowerCase();
    const isAllowed = allowlistDomains.some(domain => {
      const d = domain.toLowerCase();
      return hostname === d || hostname.endsWith('.' + d);
    });
    if (!isAllowed) {
      return {
        valid: false,
        error: `Domain ${hostname} is not in the allowlist`,
      };
    }
  }

  // Resolve and validate IPs
  const result = await resolveAndValidate(url.hostname, blockPrivateIp);
  if (!result.valid) {
    return { valid: false, error: result.error };
  }

  return { valid: true };
}

export interface SSRFCheckResult {
  safe: boolean;
  error?: string;
  resolvedAddresses?: string[];
}

/**
 * Comprehensive SSRF check for a URL
 */
export async function checkSSRF(
  urlString: string,
  options: { blockPrivateIp?: boolean; allowlistDomains?: string[] } = {}
): Promise<SSRFCheckResult> {
  const validation = await validateUrlForSSRF(urlString, options);

  if (!validation.valid) {
    return { safe: false, error: validation.error };
  }

  return { safe: true };
}
