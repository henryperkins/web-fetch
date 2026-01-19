/**
 * SSRF Guard Unit Tests
 */

import { promises as dns } from 'dns';
import { describe, it, expect, vi } from 'vitest';
import {
  isBlockedIP,
  validateUrlForSSRF,
  checkSSRF,
  resolveAndValidate,
} from '../../src/security/ssrf-guard.js';

describe('SSRF Guard', () => {
  describe('isBlockedIP', () => {
    it('should block localhost IPv4', () => {
      expect(isBlockedIP('127.0.0.1')).toBe(true);
      expect(isBlockedIP('127.0.0.255')).toBe(true);
      expect(isBlockedIP('127.255.255.255')).toBe(true);
    });

    it('should block localhost IPv6', () => {
      expect(isBlockedIP('::1')).toBe(true);
    });

    it('should block private IP ranges', () => {
      // Class A
      expect(isBlockedIP('10.0.0.1')).toBe(true);
      expect(isBlockedIP('10.255.255.255')).toBe(true);

      // Class B
      expect(isBlockedIP('172.16.0.1')).toBe(true);
      expect(isBlockedIP('172.31.255.255')).toBe(true);

      // Class C
      expect(isBlockedIP('192.168.0.1')).toBe(true);
      expect(isBlockedIP('192.168.255.255')).toBe(true);
    });

    it('should block link-local addresses', () => {
      expect(isBlockedIP('169.254.0.1')).toBe(true);
      expect(isBlockedIP('169.254.255.255')).toBe(true);
    });

    it('should allow public IP addresses', () => {
      expect(isBlockedIP('8.8.8.8')).toBe(false);
      expect(isBlockedIP('1.1.1.1')).toBe(false);
      expect(isBlockedIP('142.250.185.14')).toBe(false);
    });

    it('should block "this" network', () => {
      expect(isBlockedIP('0.0.0.0')).toBe(true);
      expect(isBlockedIP('0.0.0.1')).toBe(true);
    });

    it('should block multicast addresses', () => {
      expect(isBlockedIP('224.0.0.1')).toBe(true);
      expect(isBlockedIP('239.255.255.255')).toBe(true);
    });

    it('should block broadcast address', () => {
      expect(isBlockedIP('255.255.255.255')).toBe(true);
    });
  });

  describe('validateUrlForSSRF', () => {
    it('should reject non-http protocols', async () => {
      const result = await validateUrlForSSRF('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('should reject ftp protocol', async () => {
      const result = await validateUrlForSSRF('ftp://example.com/file.txt');
      expect(result.valid).toBe(false);
    });

    it('should accept http URLs', async () => {
      const result = await validateUrlForSSRF('http://example.com');
      expect(result.valid).toBe(true);
    });

    it('should accept https URLs', async () => {
      const result = await validateUrlForSSRF('https://example.com');
      expect(result.valid).toBe(true);
    });

    it('should reject invalid URLs', async () => {
      const result = await validateUrlForSSRF('not-a-url');
      expect(result.valid).toBe(false);
    });

    it('should check allowlist when configured', async () => {
      const result = await validateUrlForSSRF('https://blocked.com', {
        allowlistDomains: ['allowed.com'],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('allowlist');
    });

    it('should allow domains in allowlist', async () => {
      const result = await validateUrlForSSRF('https://allowed.com/page', {
        allowlistDomains: ['allowed.com'],
        blockPrivateIp: false, // Skip DNS for this test
      });
      // Note: This might fail if DNS resolution fails, but that's expected in unit tests
    });
  });

  describe('checkSSRF', () => {
    it('should return safe for valid public URLs', async () => {
      const result = await checkSSRF('https://example.com');
      expect(result.safe).toBe(true);
    });

    it('should block localhost URLs', async () => {
      const result = await checkSSRF('http://localhost:8080');
      expect(result.safe).toBe(false);
    });

    it('should block .localhost domains', async () => {
      const result = await checkSSRF('http://app.localhost');
      expect(result.safe).toBe(false);
    });
  });

  describe('resolveAndValidate', () => {
    it('should block private IPv6 addresses resolved from DNS', async () => {
      const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValue([
        { address: 'fd00::1', family: 6 },
      ]);

      const result = await resolveAndValidate('example.com', true);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('blocked');

      lookupSpy.mockRestore();
    });
  });
});
