import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRobots, resetRobotsState } from '../../src/fetcher/robots.js';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

describe('robots.txt handling', () => {
  beforeEach(() => {
    requestMock.mockReset();
    resetRobotsState();
  });

  it('caches parsed robots but evaluates allow/deny per path', async () => {
    const robotsBody = [
      'User-agent: *',
      'Disallow: /private',
      '',
    ].join('\n');

    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: {
        async text() {
          return robotsBody;
        },
        async dump() { /* noop */ },
      },
    });

    const allowRoot = await checkRobots('https://example.com/', { userAgent: 'web-fetch-mcp/1.0' });
    expect(allowRoot.allowed).toBe(true);

    const denyPrivate = await checkRobots('https://example.com/private', { userAgent: 'web-fetch-mcp/1.0' });
    expect(denyPrivate.allowed).toBe(false);

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('respects user-agent specific blocks', async () => {
    const robotsBody = [
      'User-agent: specialbot',
      'Disallow: /blocked',
      '',
      'User-agent: *',
      'Allow: /',
      '',
    ].join('\n');

    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: {
        async text() {
          return robotsBody;
        },
        async dump() { /* noop */ },
      },
    });

    const specialBot = await checkRobots('https://example.com/blocked', { userAgent: 'SpecialBot/2.0' });
    expect(specialBot.allowed).toBe(false);

    const otherBot = await checkRobots('https://example.com/open', { userAgent: 'OtherBot/1.0' });
    expect(otherBot.allowed).toBe(true);

    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
