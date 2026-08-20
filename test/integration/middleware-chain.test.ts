import { afterEach, describe, it, vi, expect } from 'vitest';
import {
  create,
  url,
  fetch,
  fetchData,
  use,
  json,
  retry,
  timeout,
  withAuth,
  withLogging,
  HTTPError,
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

  describe('full middleware chain with mocked fetch', () => {
    it('should work with retry and timeout on mocked request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(retry, 2)
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://example.com/get');
    });

    it('should handle multiple middlewares with mocked request', async () => {
      const logs: Array<{ msg: string; data?: unknown }> = [];
      const logger = (msg: string, data?: unknown) => logs.push({ msg, data });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
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

    it('should handle authentication middleware with mocked request', async () => {
      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        return Promise.resolve(new Response('ok', { status: 200 }));
      });

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(use, withAuth('test-token'))
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/headers')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(capturedHeaders.Authorization).toBe('Bearer test-token');
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://example.com/headers');
    });

    it('should retry a transient 503 end-to-end through fetchData + json', async () => {
      // Cross-layer: the retry middleware sees the resolved 503 (before
      // fetchData's HTTPError layer), waits, retries, and the json reader
      // inside the chain parses the eventual 200.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('try later', { status: 503 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: 42 }), {
            headers: { 'Content-Type': 'application/json' },
          })
        );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(retry, 2, { delay: { initial: 1 } })
        .pipe(json);

      const data = await client.pipe(url, '/answer').pipe(fetchData);

      expect(data).toEqual({ value: 42 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://example.com/answer');
      expect(mockFetch.mock.calls[1]?.[0]).toBe('https://example.com/answer');
    });

    it('should not burn retries on a permanent 404 and surface HTTPError from fetchData', async () => {
      // Cross-layer: a resolved 404 passes through retry untouched (single
      // attempt) and only becomes an HTTPError at the fetchData layer,
      // with the json-parsed error body attached.
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'missing' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(retry, 3, { delay: { initial: 1 } })
        .pipe(json);

      let caught: unknown;
      try {
        await client.pipe(url, '/missing').pipe(fetchData);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(HTTPError);
      expect((caught as HTTPError).response.status).toBe(404);
      expect((caught as HTTPError).data).toEqual({ error: 'missing' });
      expect(mockFetch).toHaveBeenCalledTimes(1); // single attempt: 404 is permanent
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
