import { afterEach, describe, it, vi, expect } from 'vitest';
import {
  create,
  url,
  fetch,
  use,
  json,
  retry,
  timeout,
  withAuth,
  withLogging,
} from '@/index';
import type { MiddlewareFn } from '@/types';
import { getData } from '@/util';

describe('Middleware Chain Integration Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onion model execution', () => {
    it('should execute middlewares in correct onion order (outer to inner to outer)', async () => {
      const executionOrder: string[] = [];

      const outer1: MiddlewareFn = (f) => async (...params) => {
        executionOrder.push('outer1-enter');
        const res = await f(...params);
        executionOrder.push('outer1-exit');
        return res;
      };

      const outer2: MiddlewareFn = (f) => async (...params) => {
        executionOrder.push('outer2-enter');
        const res = await f(...params);
        executionOrder.push('outer2-exit');
        return res;
      };

      const inner1: MiddlewareFn = (f) => async (...params) => {
        executionOrder.push('inner1-enter');
        const res = await f(...params);
        executionOrder.push('inner1-exit');
        return res;
      };

      const inner2: MiddlewareFn = (f) => async (...params) => {
        executionOrder.push('inner2-enter');
        const res = await f(...params);
        executionOrder.push('inner2-exit');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'outer1', outer: 'inner1', middleware: outer1 })
        .pipe(use, { name: 'outer2', outer: 'inner2', middleware: outer2 })
        .pipe(use, { name: 'inner1', middleware: inner1 })
        .pipe(use, { name: 'inner2', middleware: inner2 });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(executionOrder).toEqual([
        'outer1-enter',
        'outer2-enter',
        'inner1-enter',
        'inner2-enter',
        'inner2-exit',
        'inner1-exit',
        'outer2-exit',
        'outer1-exit',
      ]);
    });

    it('should handle multiple middlewares wrapping a single inner middleware', async () => {
      const order: string[] = [];

      const outermost: MiddlewareFn = (f) => async (...params) => {
        order.push('outermost-enter');
        const res = await f(...params);
        order.push('outermost-exit');
        return res;
      };

      const middle: MiddlewareFn = (f) => async (...params) => {
        order.push('middle-enter');
        const res = await f(...params);
        order.push('middle-exit');
        return res;
      };

      const innermost: MiddlewareFn = (f) => async (...params) => {
        order.push('innermost-enter');
        const res = await f(...params);
        order.push('innermost-exit');
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'middle', outer: 'innermost', middleware: middle })
        .pipe(use, { name: 'outermost', outer: 'middle', middleware: outermost })
        .pipe(use, { name: 'innermost', middleware: innermost });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual([
        'outermost-enter',
        'middle-enter',
        'innermost-enter',
        'innermost-exit',
        'middle-exit',
        'outermost-exit',
      ]);
    });

    it('should work with built-in middlewares in correct order', async () => {
      const order: string[] = [];

      const trackingRetry: MiddlewareFn = (f) => async (...params) => {
        order.push('retry-enter');
        const res = await f(...params);
        order.push('retry-exit');
        return res;
      };

      const trackingTimeout: MiddlewareFn = (f) => async (...params) => {
        order.push('timeout-enter');
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
        'timeout-enter',
        'retry-enter',
        'retry-exit',
        'timeout-out',
      ]);
    });
  });

  describe('full middleware chain with real fetch', () => {
    it('should work with retry and timeout on real request', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(retry, 2)
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('should handle multiple middlewares with real request', async () => {
      const logs: Array<{ msg: string; data?: unknown }> = [];
      const logger = (msg: string, data?: unknown) => logs.push({ msg, data });

      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(use, withLogging(logger))
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs[0]?.msg).toBe('Request:');
      expect(logs[1]?.msg).toBe('Response:');
    });

    it('should handle authentication middleware with real request', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(use, withAuth('test-token'))
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/headers')
        .pipe(fetch);

      expect(response.ok).toBe(true);
    });
  });

  describe('middleware chain with data transformation', () => {
    it('should transform response through middleware chain', async () => {
      let capturedResponse: unknown = null;

      const trackingMiddleware: MiddlewareFn = (f) => async (...params) => {
        const res = await f(...params);
        capturedResponse = res;
        return res;
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: 'test' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = create({ fetch: mockFetch })
        .pipe(use, trackingMiddleware)
        .pipe(json);

      const result = await client.pipe(url, 'https://example.com').pipe(fetch);

      const data = getData(result);
      expect(data).toEqual({ data: 'test' });
      expect(capturedResponse).toBeDefined();
    });
  });
});
