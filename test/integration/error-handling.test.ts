import { afterEach, describe, it, vi, expect } from 'vitest';
import {
  create,
  url,
  fetch,
  use,
  json,
  checkError,
  mapResponse,
  retry,
  timeout,
} from '@/index';
import type { MiddlewareFn } from '@/types';
import { getData } from '@/util';

describe('Error Handling Integration Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkError middleware catches errors', () => {
    it('should throw when response status is not ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404, statusText: 'Not Found' })
      );

      const client = create({ fetch: mockFetch })
        .pipe(checkError, (res) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
        });

      await expect(
        client.pipe(url, 'https://example.com/notfound').pipe(fetch)
      ).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should catch error thrown in checkError middleware', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 500 })
      );

      const client = create({ fetch: mockFetch })
        .pipe(checkError, (res) => {
          if (res.status >= 500) {
            throw new Error('Server error occurred');
          }
        });

      await expect(
        client.pipe(url, 'https://example.com/error').pipe(fetch)
      ).rejects.toThrow('Server error occurred');
    });

    it('should allow response through when checkError passes', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 200 }))
      );

      const client = create({ fetch: mockFetch })
        .pipe(checkError, (res) => {
          if (!res.ok) throw new Error(`Bad response: ${res.status}`);
        });

      const result = await client
        .pipe(url, 'https://example.com/success')
        .pipe(fetch);

      expect(result.ok).toBe(true);
    });
  });

  describe('middleware errors propagate correctly', () => {
    it('should propagate error from innermost middleware', async () => {
      const errorMiddleware: MiddlewareFn = (f) => async () => {
        throw new Error('Middleware error');
      };

      const mockFetch = vi.fn();

      const client = create({ fetch: mockFetch })
        .pipe(use, errorMiddleware);

      await expect(
        client.pipe(url, 'https://example.com').pipe(fetch)
      ).rejects.toThrow('Middleware error');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should propagate error from outer middleware when inner throws', async () => {
      const order: string[] = [];

      const outerMiddleware: MiddlewareFn = (f) => async (...params) => {
        order.push('outer-before');
        try {
          const res = await f(...params);
          order.push('outer-after-success');
          return res;
        } catch (e) {
          order.push('outer-after-error');
          throw e;
        }
      };

      const innerErrorMiddleware: MiddlewareFn = (f) => async () => {
        order.push('inner-before');
        throw new Error('Inner error');
      };

      const mockFetch = vi.fn();

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'outer', outer: 'inner', middleware: outerMiddleware })
        .pipe(use, { name: 'inner', middleware: innerErrorMiddleware });

      await expect(
        client.pipe(url, 'https://example.com').pipe(fetch)
      ).rejects.toThrow('Inner error');

      expect(order).toEqual([
        'outer-before',
        'inner-before',
        'outer-after-error',
      ]);
    });

    it('should execute all enter phases before any error propagates', async () => {
      const order: string[] = [];

      const mw1: MiddlewareFn = (f) => async (...params) => {
        order.push('mw1-enter');
        const res = await f(...params);
        order.push('mw1-exit');
        return res;
      };

      const mw2: MiddlewareFn = (f) => async (...params) => {
        order.push('mw2-enter');
        const res = await f(...params);
        order.push('mw2-exit');
        return res;
      };

      const mw3: MiddlewareFn = (f) => async () => {
        order.push('mw3-enter');
        throw new Error('mw3 error');
      };

      const mockFetch = vi.fn();

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'mw1', middleware: mw1 })
        .pipe(use, { name: 'mw2', middleware: mw2 })
        .pipe(use, { name: 'mw3', middleware: mw3 });

      await expect(
        client.pipe(url, 'https://example.com').pipe(fetch)
      ).rejects.toThrow('mw3 error');

      expect(order).toEqual(['mw1-enter', 'mw2-enter', 'mw3-enter']);
    });
  });

  describe('retry handles errors correctly', () => {
    it('should not retry when checkError throws', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = create({ fetch: mockFetch })
        .pipe(checkError, (res) => {
          if (!res.ok) throw new Error('Request failed');
        })
        .pipe(retry, 3);

      await expect(
        client.pipe(url, 'https://example.com').pipe(fetch)
      ).rejects.toThrow('Request failed');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('mapResponse handles errors', () => {
    it('should catch error in mapResponse mapper', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('invalid json', { status: 200 })
      );

      const client = create({ fetch: mockFetch })
        .pipe(mapResponse, async (res) => {
          const text = await res.text();
          if (text === 'invalid json') {
            throw new Error('Parse error');
          }
          return res;
        });

      await expect(
        client.pipe(url, 'https://example.com').pipe(fetch)
      ).rejects.toThrow('Parse error');
    });
  });

  describe('real HTTP error handling', () => {
    it('should handle 404 error from real HTTP request', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(checkError, (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        })
        .pipe(timeout, 10000);

      await expect(
        client.pipe(url, '/status/404').pipe(fetch)
      ).rejects.toThrow('HTTP 404');
    });

    it('should handle 500 error from real HTTP request', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(checkError, (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        })
        .pipe(timeout, 10000);

      await expect(
        client.pipe(url, '/status/500').pipe(fetch)
      ).rejects.toThrow('HTTP 500');
    });
  });
});
