import { afterEach, describe, it, vi, expect } from 'vitest';
import {
  create,
  url,
  fetch,
  use,
  withRetry,
  withTimeout,
  withAuth,
  withLogging,
  NORMAL,
} from '@/index';
import type { MiddlewareFn } from '@/types';

describe('Middleware Positioning Integration Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('before/after positioning with outer constraint', () => {
    it('should position middleware outside (before) another using outer constraint', async () => {
      const order: string[] = [];

      const outerMiddleware: MiddlewareFn = (f) => async (...params) => {
        order.push('outer-before');
        const res = await f(...params);
        order.push('outer-after');
        return res;
      };

      const innerMiddleware: MiddlewareFn = (f) => async (...params) => {
        order.push('inner-before');
        const res = await f(...params);
        order.push('inner-after');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'outer', outer: 'inner', middleware: outerMiddleware })
        .pipe(use, { name: 'inner', middleware: innerMiddleware });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'outer-before',
        'inner-before',
        'inner-after',
        'outer-after',
      ]);
    });

    it('should position middleware inside (after) another using inner constraint', async () => {
      const order: string[] = [];

      const outerMiddleware: MiddlewareFn = (f) => async (...params) => {
        order.push('outer-before');
        const res = await f(...params);
        order.push('outer-after');
        return res;
      };

      const innerMiddleware: MiddlewareFn = (f) => async (...params) => {
        order.push('inner-before');
        const res = await f(...params);
        order.push('inner-after');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'outer', middleware: outerMiddleware })
        .pipe(use, { name: 'inner', inner: 'outer', middleware: innerMiddleware });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'outer-before',
        'inner-before',
        'inner-after',
        'outer-after',
      ]);
    });
  });

  describe('builtin middleware positioning', () => {
    it('withTimeout should wrap withRetry (timeout outer of retry)', async () => {
      const order: string[] = [];

      const trackingRetry: MiddlewareFn = (f) => async (...params) => {
        order.push('retry-in');
        const res = await f(...params);
        order.push('retry-out');
        return res;
      };

      const trackingTimeout: MiddlewareFn = (f) => async (...params) => {
        order.push('timeout-in');
        const res = await f(...params);
        order.push('timeout-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'builtin:retry', middleware: trackingRetry })
        .pipe(use, {
          name: 'builtin:timeout',
          outer: 'builtin:retry',
          middleware: trackingTimeout,
        });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'timeout-in',
        'retry-in',
        'retry-out',
        'timeout-out',
      ]);
    });

    it('withAuth should be inside withRetry (auth inner of retry)', async () => {
      const order: string[] = [];

      const trackingRetry: MiddlewareFn = (f) => async (...params) => {
        order.push('retry-in');
        const res = await f(...params);
        order.push('retry-out');
        return res;
      };

      const trackingAuth: MiddlewareFn = (f) => async (...params) => {
        order.push('auth-in');
        const res = await f(...params);
        order.push('auth-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'builtin:retry', middleware: trackingRetry })
        .pipe(use, {
          name: 'builtin:auth',
          inner: 'builtin:retry',
          middleware: trackingAuth,
        });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'retry-in',
        'auth-in',
        'auth-out',
        'retry-out',
      ]);
    });

    it('withLogging should be outermost (outer of NORMAL)', async () => {
      const order: string[] = [];

      const trackingNormal: MiddlewareFn = (f) => async (...params) => {
        order.push('normal-in');
        const res = await f(...params);
        order.push('normal-out');
        return res;
      };

      const trackingLogging: MiddlewareFn = (f) => async (...params) => {
        order.push('logging-in');
        const res = await f(...params);
        order.push('logging-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: NORMAL, middleware: trackingNormal })
        .pipe(use, {
          name: 'builtin:logging',
          outer: NORMAL,
          middleware: trackingLogging,
        });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'logging-in',
        'normal-in',
        'normal-out',
        'logging-out',
      ]);
    });
  });

  describe('complex positioning chains', () => {
    it('should handle chain: a outer b outer c', async () => {
      const order: string[] = [];

      const a: MiddlewareFn = (f) => async (...params) => {
        order.push('a-in');
        const res = await f(...params);
        order.push('a-out');
        return res;
      };

      const b: MiddlewareFn = (f) => async (...params) => {
        order.push('b-in');
        const res = await f(...params);
        order.push('b-out');
        return res;
      };

      const c: MiddlewareFn = (f) => async (...params) => {
        order.push('c-in');
        const res = await f(...params);
        order.push('c-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'c', middleware: c })
        .pipe(use, { name: 'b', outer: 'c', middleware: b })
        .pipe(use, { name: 'a', outer: 'b', middleware: a });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'a-in', 'b-in', 'c-in',
        'c-out', 'b-out', 'a-out',
      ]);
    });

    it('should handle inner chain: c inner b inner a', async () => {
      const order: string[] = [];

      const a: MiddlewareFn = (f) => async (...params) => {
        order.push('a-in');
        const res = await f(...params);
        order.push('a-out');
        return res;
      };

      const b: MiddlewareFn = (f) => async (...params) => {
        order.push('b-in');
        const res = await f(...params);
        order.push('b-out');
        return res;
      };

      const c: MiddlewareFn = (f) => async (...params) => {
        order.push('c-in');
        const res = await f(...params);
        order.push('c-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'a', middleware: a })
        .pipe(use, { name: 'b', inner: 'a', middleware: b })
        .pipe(use, { name: 'c', inner: 'b', middleware: c });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'a-in', 'b-in', 'c-in',
        'c-out', 'b-out', 'a-out',
      ]);
    });

    it('should handle mixed outer and inner constraints', async () => {
      const order: string[] = [];

      const a: MiddlewareFn = (f) => async (...params) => {
        order.push('a-in');
        const res = await f(...params);
        order.push('a-out');
        return res;
      };

      const b: MiddlewareFn = (f) => async (...params) => {
        order.push('b-in');
        const res = await f(...params);
        order.push('b-out');
        return res;
      };

      const c: MiddlewareFn = (f) => async (...params) => {
        order.push('c-in');
        const res = await f(...params);
        order.push('c-out');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'a', middleware: a })
        .pipe(use, { name: 'c', middleware: c })
        .pipe(use, { name: 'b', outer: 'a', inner: 'c', middleware: b });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'c-in', 'b-in', 'a-in',
        'a-out', 'b-out', 'c-out',
      ]);
    });
  });

  describe('real HTTP positioning tests', () => {
    it('should work with real request using multiple positioned middlewares', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(use, withLogging())
        .pipe(use, withTimeout(10000));

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
    });
  });
});
