import { afterEach, beforeEach, describe, it, vi, expect } from 'vitest';
import {
  retry,
  create,
  url,
  fetch,
  use,
  withRetry,
  withTimeout,
  withAuth,
  withLogging,
  sortMiddlewares,
  normalizeMiddleware,
  NORMAL,
} from '@/index';
import type { MiddlewareFn, MiddlewareEntry } from '../src/types';
import { asNotRetryError } from '@/util';

describe('Middleware Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should retry the specified number of times', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Test Error'));
    const client = create({ fetch: mockFetch }).pipe(retry, 3);

    vi.runAllTimersAsync();

    await client
      .pipe(url, 'https://example.com')
      .pipe(fetch)
      .should.rejects.to.throw('Test Error' as any);

    mockFetch.mock.calls.length.should.be.equal(4);
  });

  it('should not retry if the function succeeds', async () => {
    const mockFetch = vi.fn().mockResolvedValue('Success');
    const client = create({ fetch: mockFetch }).pipe(retry, 3);
    await client.pipe(url, 'https://example.com').pipe(fetch);

    mockFetch.mock.calls.length.should.be.equal(1);
  });

  it('should not retry when error is marked as not retryable', async () => {
    const originalError = new Error('Not retryable');
    const mockFetch = vi.fn().mockRejectedValue(asNotRetryError(originalError));
    const client = create({ fetch: mockFetch }).pipe(retry, 3);

    vi.runAllTimersAsync();

    await client
      .pipe(url, 'https://example.com')
      .pipe(fetch)
      .should.rejects.to.throw('Not retryable' as any);

    // Should only be called once, no retries
    mockFetch.mock.calls.length.should.be.equal(1);
  });
});

describe('Middleware Ordering', () => {
  describe('normalizeMiddleware', () => {
    it('should normalize a simple function to MiddlewareEntry', () => {
      const fn: MiddlewareFn = (f) => f;
      const entry = normalizeMiddleware(fn);

      expect(entry.middleware).toBe(fn);
      expect(typeof entry.name).toBe('symbol');
      expect(entry.outer).toBeUndefined();
      expect(entry.inner).toBeUndefined();
    });

    it('should normalize a config object to MiddlewareEntry', () => {
      const fn: MiddlewareFn = (f) => f;
      const entry = normalizeMiddleware({
        name: 'builtin:test',
        outer: 'builtin:retry',
        middleware: fn,
      });

      expect(entry.middleware).toBe(fn);
      expect(entry.name).toBe('builtin:test');
      expect(entry.outer).toBe('builtin:retry');
      expect(entry.inner).toBeUndefined();
    });

    it('should generate unique names for unnamed middlewares', () => {
      const fn: MiddlewareFn = (f) => f;
      const entry1 = normalizeMiddleware(fn);
      const entry2 = normalizeMiddleware(fn);

      expect(entry1.name).not.toBe(entry2.name);
    });

    it('should generate symbol name for config without name', () => {
      const fn: MiddlewareFn = (f) => f;
      const entry = normalizeMiddleware({
        outer: 'builtin:retry',
        middleware: fn,
      });

      expect(entry.middleware).toBe(fn);
      expect(typeof entry.name).toBe('symbol');
      expect(entry.outer).toBe('builtin:retry');
    });
  });

  describe('sortMiddlewares', () => {
    it('should return empty array for empty input', () => {
      expect(sortMiddlewares([])).toEqual([]);
    });

    it('should return single element unchanged', () => {
      const entry: MiddlewareEntry = {
        name: 'test',
        middleware: (f) => f,
      };
      expect(sortMiddlewares([entry])).toEqual([entry]);
    });

    it('should sort based on outer constraint', () => {
      const inner: MiddlewareEntry = {
        name: 'inner',
        middleware: (f) => f,
      };
      const outer: MiddlewareEntry = {
        name: 'outer',
        outer: 'inner', // outer should wrap inner
        middleware: (f) => f,
      };

      // Regardless of input order, outer should come first
      const sorted = sortMiddlewares([inner, outer]);
      expect(sorted[0]!.name).toBe('outer');
      expect(sorted[1]!.name).toBe('inner');
    });

    it('should sort based on inner constraint', () => {
      const outer: MiddlewareEntry = {
        name: 'outer',
        middleware: (f) => f,
      };
      const inner: MiddlewareEntry = {
        name: 'inner',
        inner: 'outer', // inner should be wrapped by outer
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([inner, outer]);
      expect(sorted[0]!.name).toBe('outer');
      expect(sorted[1]!.name).toBe('inner');
    });

    it('should handle complex dependency chain', () => {
      const a: MiddlewareEntry = { name: 'a', middleware: (f) => f };
      const b: MiddlewareEntry = {
        name: 'b',
        inner: 'a', // b is inside a
        middleware: (f) => f,
      };
      const c: MiddlewareEntry = {
        name: 'c',
        inner: 'b', // c is inside b
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([c, a, b]);
      expect(sorted.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    });

    it('should handle NORMAL positioning', () => {
      const normal: MiddlewareEntry = {
        name: NORMAL,
        middleware: (f) => f,
      };
      const outerOfNormal: MiddlewareEntry = {
        name: 'logging',
        outer: NORMAL,
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([normal, outerOfNormal]);
      expect(sorted[0]!.name).toBe('logging');
      expect(sorted[1]!.name).toBe(NORMAL);
    });

    it('should handle circular dependency gracefully', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const a: MiddlewareEntry = {
        name: 'a',
        outer: 'b', // a should wrap b
        middleware: (f) => f,
      };
      const b: MiddlewareEntry = {
        name: 'b',
        outer: 'a', // b should wrap a (circular!)
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([a, b]);

      // Should return original order and warn
      expect(warnSpy).toHaveBeenCalledWith(
        'Middleware dependency cycle detected, using original order'
      );
      expect(sorted).toEqual([a, b]);

      warnSpy.mockRestore();
    });

    it('should handle outer constraint referencing non-existent middleware', () => {
      const a: MiddlewareEntry = {
        name: 'a',
        outer: 'non-existent', // references middleware not in the list
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([a]);
      expect(sorted).toEqual([a]);
    });

    it('should handle inner constraint referencing non-existent middleware', () => {
      const a: MiddlewareEntry = {
        name: 'a',
        inner: 'non-existent', // references middleware not in the list
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([a]);
      expect(sorted).toEqual([a]);
    });

    it('should handle middleware with both outer and inner constraints', () => {
      const a: MiddlewareEntry = { name: 'a', middleware: (f) => f };
      const b: MiddlewareEntry = {
        name: 'b',
        outer: 'c', // b wraps c
        inner: 'a', // b is inside a
        middleware: (f) => f,
      };
      const c: MiddlewareEntry = { name: 'c', middleware: (f) => f };

      const sorted = sortMiddlewares([c, b, a]);
      const names = sorted.map((e) => e.name);
      expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
      expect(names.indexOf('b')).toBeLessThan(names.indexOf('c'));
    });

    it('should handle multiple middlewares with same outer target', () => {
      const target: MiddlewareEntry = { name: 'target', middleware: (f) => f };
      const outer1: MiddlewareEntry = {
        name: 'outer1',
        outer: 'target',
        middleware: (f) => f,
      };
      const outer2: MiddlewareEntry = {
        name: 'outer2',
        outer: 'target',
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([target, outer1, outer2]);
      const targetIndex = sorted.findIndex((e) => e.name === 'target');
      const outer1Index = sorted.findIndex((e) => e.name === 'outer1');
      const outer2Index = sorted.findIndex((e) => e.name === 'outer2');

      expect(outer1Index).toBeLessThan(targetIndex);
      expect(outer2Index).toBeLessThan(targetIndex);
    });

    it('should reuse edges set for same middleware name', () => {
      const a: MiddlewareEntry = {
        name: 'a',
        outer: 'b',
        inner: 'c', // a has both outer and inner, so getEdges('a') called twice
        middleware: (f) => f,
      };
      const b: MiddlewareEntry = { name: 'b', middleware: (f) => f };
      const c: MiddlewareEntry = {
        name: 'c',
        outer: 'a', // c also has outer pointing to a
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([a, b, c]);
      expect(sorted).toHaveLength(3);
    });

    it('should handle chain where target has edges to process', () => {
      const a: MiddlewareEntry = { name: 'a', middleware: (f) => f };
      const b: MiddlewareEntry = {
        name: 'b',
        inner: 'a',
        middleware: (f) => f,
      };
      const c: MiddlewareEntry = {
        name: 'c',
        inner: 'b',
        middleware: (f) => f,
      };
      const d: MiddlewareEntry = {
        name: 'd',
        inner: 'c',
        middleware: (f) => f,
      };

      const sorted = sortMiddlewares([d, c, b, a]);
      expect(sorted.map((e) => e.name)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('builtin middleware factories', () => {
    it('withRetry should create config with correct name', () => {
      const config = withRetry(3);
      expect(config.name).toBe('builtin:retry');
      expect(typeof config.middleware).toBe('function');
    });

    it('withTimeout should create config with outer constraint', () => {
      const config = withTimeout(5000);
      expect(config.name).toBe('builtin:timeout');
      expect(config.outer).toBe('builtin:retry');
    });

    it('withAuth should create config with inner constraint', () => {
      const config = withAuth('token123');
      expect(config.name).toBe('builtin:auth');
      expect(config.inner).toBe('builtin:retry');
    });

    it('withLogging should create config with outer NORMAL constraint', () => {
      const config = withLogging();
      expect(config.name).toBe('builtin:logging');
      expect(config.outer).toBe(NORMAL);
    });

    it('withTimeout middleware should add AbortSignal', async () => {
      const config = withTimeout(5000);
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', {});

      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    });

    it('withAuth middleware should add Authorization header', async () => {
      const config = withAuth('my-token');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', {
        headers: { 'X-Custom': 'value' },
      });

      expect(
        (capturedInit?.headers as Record<string, string>)?.Authorization
      ).toBe('Bearer my-token');
      expect(
        (capturedInit?.headers as Record<string, string>)?.['X-Custom']
      ).toBe('value');
    });

    it('withAuth middleware should work without existing headers', async () => {
      const config = withAuth('my-token');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(
        (capturedInit?.headers as Record<string, string>)?.Authorization
      ).toBe('Bearer my-token');
    });

    it('withLogging middleware should log request and response', async () => {
      const logs: Array<{ msg: string; data?: unknown }> = [];
      const logger = (msg: string, data?: unknown) => logs.push({ msg, data });
      const config = withLogging(logger);

      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('ok', { status: 200 }));
      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );
      await wrappedFetch('https://example.com');

      expect(logs).toHaveLength(2);
      expect(logs[0]!.msg).toBe('Request:');
      expect(logs[1]!.msg).toBe('Response:');
    });

    it('withLogging middleware should log errors', async () => {
      const logs: Array<{ msg: string; data?: unknown }> = [];
      const logger = (msg: string, data?: unknown) => logs.push({ msg, data });
      const config = withLogging(logger);

      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );

      await expect(wrappedFetch('https://example.com')).rejects.toThrow(
        'Network error'
      );

      expect(logs).toHaveLength(2);
      expect(logs[0]!.msg).toBe('Request:');
      expect(logs[1]!.msg).toBe('Error:');
    });
  });

  describe('use with MiddlewareConfig', () => {
    it('should accept simple middleware function', () => {
      const fn: MiddlewareFn = (f) => f;
      const client = use({}, fn);

      expect(client.middlewares).toHaveLength(1);
      expect(client.middlewares[0]!.middleware).toBe(fn);
    });

    it('should accept middleware config object', () => {
      const config = withRetry(3);
      const client = use({}, config);

      expect(client.middlewares).toHaveLength(1);
      expect(client.middlewares[0]!.name).toBe('builtin:retry');
    });

    it('should accumulate middlewares', () => {
      const client = use(
        use(use({}, withRetry(3)), withTimeout(5000)),
        withAuth('token')
      );

      expect(client.middlewares).toHaveLength(3);
    });
  });

  describe('middleware execution order', () => {
    it('should execute middlewares in correct onion order', async () => {
      const order: string[] = [];

      const outer: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('outer-in');
          const res = await f(...params);
          order.push('outer-out');
          return res;
        };

      const inner: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('inner-in');
          const res = await f(...params);
          order.push('inner-out');
          return res;
        };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'outer', outer: 'inner', middleware: outer })
        .pipe(use, { name: 'inner', middleware: inner });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      expect(order).toEqual(['outer-in', 'inner-in', 'inner-out', 'outer-out']);
    });

    it('should respect builtin middleware ordering', async () => {
      const order: string[] = [];

      const trackingRetry: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('retry-in');
          const res = await f(...params);
          order.push('retry-out');
          return res;
        };

      const trackingTimeout: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('timeout-in');
          const res = await f(...params);
          order.push('timeout-out');
          return res;
        };

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      // Add in reverse order to test sorting
      const client = create({ fetch: mockFetch })
        .pipe(use, { name: 'builtin:retry', middleware: trackingRetry })
        .pipe(use, {
          name: 'builtin:timeout',
          outer: 'builtin:retry',
          middleware: trackingTimeout,
        });

      await client.pipe(url, 'https://example.com').pipe(fetch);

      // timeout should wrap retry
      expect(order).toEqual([
        'timeout-in',
        'retry-in',
        'retry-out',
        'timeout-out',
      ]);
    });
  });
});
