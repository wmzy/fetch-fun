import { afterEach, beforeEach, describe, it, vi, expect } from 'vitest';
import {
  retry,
  create,
  url,
  fetch,
  use,
  signal,
  method,
  checkError,
  json,
  validate,
  withRetry,
  withTimeout,
  withAuth,
  withLogging,
  sortMiddlewares,
  normalizeMiddleware,
  NORMAL,
} from '@/index';
import { TimeoutError, HTTPError, ValidationError } from '@/index';
import type { MiddlewareFn, MiddlewareEntry, StandardSchema } from '../src/types';
import { asNotRetryError } from '@/util';

describe('Middleware Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should retry the specified number of times', async () => {
    // Under the smart retry policy this still exhausts all attempts:
    // a plain Error on the default GET method is an unknown (transient)
    // failure with a retryable method.
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

  // =========================================================================
  // Smart retry policy: status / method / error-type aware, Retry-After aware
  // =========================================================================

  it('should not retry a 404 response (non-retryable status)', async () => {
    // Regression: the old implementation retried unconditionally and burned
    // all attempts on a permanent 404 (4 calls with retry=3).
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 }));
    const client = create({ fetch: mockFetch }).pipe(retry, 3, {
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should retry a 500 response up to maxRetries and return the last response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Server Error', { status: 500 }));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should prefer a Retry-After header over backoff (integer seconds)', async () => {
    // Real timers: Retry-After: 0 must make the retry immediate even
    // though the (unused) backoff initial is 2s.
    vi.useRealTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      )
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 2000 },
    });

    const start = Date.now();
    const res = await client.pipe(url, 'https://example.com').pipe(fetch);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeLessThan(1000); // waited ~0ms, not the 2s backoff
  });

  it('should prefer a future Retry-After HTTP-date over backoff', async () => {
    vi.useRealTimers();
    // +1080ms: toUTCString() truncates to whole seconds, so the offset must
    // clear up to 1s of truncation and still leave a measurable wait.
    const retryAfter = new Date(Date.now() + 1080).toUTCString();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 503,
          headers: { 'Retry-After': retryAfter },
        })
      )
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 1 },
    });

    const start = Date.now();
    const res = await client.pipe(url, 'https://example.com').pipe(fetch);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(70); // waited the HTTP-date, not the 1ms backoff
  });

  it('should ignore a past Retry-After date and fall back to backoff', async () => {
    vi.useRealTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 503,
          headers: {
            'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT', // in the past
          },
        })
      )
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 40 },
    });

    const start = Date.now();
    await client.pipe(url, 'https://example.com').pipe(fetch);
    const elapsed = Date.now() - start;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(30); // backoff (~40ms) was used
  });

  it('should use backoff when respectRetryAfter is false', async () => {
    vi.useRealTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      )
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      respectRetryAfter: false,
      delay: { initial: 40 },
    });

    const start = Date.now();
    await client.pipe(url, 'https://example.com').pipe(fetch);
    const elapsed = Date.now() - start;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(30); // header ignored → ~40ms backoff
  });

  it('should cancel the discarded response body before retrying', async () => {
    const first = new Response('busy', { status: 503 });
    const cancel = vi.spyOn(first.body!, 'cancel');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1); // the leaked 503 body was released
  });

  it('should not retry a non-idempotent method (POST) on a retryable status', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('confused', { status: 500 }));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 1 } })
      .pipe(method, 'POST');

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1); // never retried: side effects
  });

  it('should retry an idempotent method (GET) on a retryable status', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 1 } })
      .pipe(method, 'GET');

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should retry a network error (TypeError) on GET until maxRetries', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      delay: { initial: 1 },
    });

    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow('fetch failed');
    expect(mockFetch).toHaveBeenCalledTimes(3); // exhausted all attempts
  });

  it('should not retry a network error (TypeError) on POST', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 2, { delay: { initial: 1 } })
      .pipe(method, 'POST');

    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow('fetch failed');
    expect(mockFetch).toHaveBeenCalledTimes(1); // immediate rethrow
  });

  it('should not retry an HTTPError(404) thrown by a checkError middleware', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 }));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 1 } })
      .pipe(checkError, (res) => {
        if (!res.ok) throw new HTTPError(res);
      });

    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow(HTTPError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // 404 ∉ retryable statuses
  });

  it('should retry an HTTPError(503) thrown by a checkError middleware until maxRetries', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 2, { delay: { initial: 1 } })
      .pipe(checkError, (res) => {
        if (!res.ok) throw new HTTPError(res);
      });

    let caught: unknown;
    try {
      await client.pipe(url, 'https://example.com').pipe(fetch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect((caught as HTTPError).response.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, then rethrow
  });

  it('should not retry a ValidationError from a failing schema', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ n: 'not a number' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const failingSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'expected number' }] }),
      },
    } as const satisfies StandardSchema;
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 1 } })
      .pipe(json)
      .pipe(validate, failingSchema);

    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow(ValidationError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // validation is deterministic
  });

  it('should honor custom statuses (retry a normally-ignored 404)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      statuses: [404],
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should honor custom methods (retry POST when whitelisted, case-insensitive)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('created', { status: 201 }));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 2, { methods: ['post'], delay: { initial: 1 } })
      .pipe(method, 'POST');

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(201);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

    it('should sort outer:NORMAL < anonymous < inner:NORMAL regardless of input order', () => {
      const outerOfNormal = normalizeMiddleware(withLogging());
      const innerOfNormal: MiddlewareEntry = {
        name: 'inner-normal',
        inner: NORMAL,
        middleware: (f) => f,
      };
      const anon1: MiddlewareEntry = { name: 'anon1', middleware: (f) => f };
      const anon2: MiddlewareEntry = { name: 'anon2', middleware: (f) => f };

      // Adversarial order: anonymous first, inner:NORMAL second, outer:NORMAL last
      const sorted = sortMiddlewares([
        anon1,
        innerOfNormal,
        anon2,
        outerOfNormal,
      ]);

      expect(sorted.map((e) => String(e.name))).toEqual([
        'builtin:logging',
        'anon1',
        'anon2',
        'inner-normal',
      ]);
    });

    it('should not report a cycle when inner target is unregistered', () => {
      // withAuth(inner: 'builtin:retry') without a registered retry used to
      // keep its in-degree positive forever and trip the cycle detector.
      const entries = [
        normalizeMiddleware(withAuth('token')),
        normalizeMiddleware(withLogging()),
      ];

      expect(() => sortMiddlewares(entries)).not.toThrow();
    });

    it('should throw on circular dependency with cycle names in message', () => {
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

      // Should throw a diagnosable error naming the cycle members
      expect(() => sortMiddlewares([a, b])).toThrow(/cycle/i);
      try {
        sortMiddlewares([a, b]);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('a');
        expect(message).toContain('b');
        expect(message).toMatch(/a -> b -> a|b -> a -> b/);
      }
    });

    it('should throw on duplicate middleware names', () => {
      // Two `use(withRetry(3))` registrations normalize to entries that
      // both carry the fixed name 'builtin:retry'
      const entries = [
        normalizeMiddleware(withRetry(3)),
        normalizeMiddleware(withRetry(3)),
      ];

      expect(() => sortMiddlewares(entries)).toThrow(
        /Duplicate middleware name "builtin:retry"/
      );
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

    it('withTimeout should create config with inner constraint (fresh budget per retry)', () => {
      const config = withTimeout(5000);
      expect(config.name).toBe('builtin:timeout');
      expect(config.inner).toBe('builtin:retry');
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

    it('withTimeout middleware should add AbortSignal, fresh on every call', async () => {
      const config = withTimeout(5000);
      const signals: AbortSignal[] = [];
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        signals.push(init!.signal!);
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any);
      await wrappedFetch('https://example.com', {});
      await wrappedFetch('https://example.com', {});

      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).not.toBe(signals[0]); // a fresh signal per call
    });

    it('withTimeout + withRetry: each retry attempt gets a fresh signal', async () => {
      // AbortSignal.timeout runs on the native event loop; use real timers
      // (fake timers leak from the "Middleware Tests" describe above).
      vi.useRealTimers();
      const signals: (AbortSignal | undefined)[] = [];
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        signals.push(init?.signal);
        if (mockFetch.mock.calls.length === 1) {
          return Promise.reject(new Error('Temporary failure'));
        }
        return Promise.resolve(new Response('ok'));
      });

      const client = create({ fetch: mockFetch as any })
        .pipe(use, withTimeout(100))
        .pipe(use, withRetry(1));

      const response = await client
        .pipe(url, 'https://example.com')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second attempt: a brand-new, un-aborted signal...
      expect(signals[1]).toBeDefined();
      expect(signals[1]!.aborted).toBe(false);
      expect(signals[1]).not.toBe(signals[0]);
      // ...while the first attempt's 100ms budget expired during the backoff.
      expect(signals[0]!.aborted).toBe(true);
    });

    it('withTimeout maps a timeout abort to TimeoutError with cause chain', async () => {
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = create({ fetch: mockFetch as any }).pipe(
        use,
        withTimeout(30)
      );

      let caught: unknown;
      try {
        await client.pipe(url, 'https://example.com').pipe(fetch);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).message).toBe(
        'Request timed out after 30ms'
      );
      expect((caught as TimeoutError).cause).toBeInstanceOf(DOMException);
      expect((caught as TimeoutError).cause).toMatchObject({
        name: 'TimeoutError',
      });
    });

    it('withTimeout propagates a user abort unchanged (AbortError)', async () => {
      const controller = new AbortController();
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = create({ fetch: mockFetch as any })
        .pipe(use, withTimeout(5000))
        .pipe(signal, controller.signal);

      const pending = client.pipe(url, 'https://example.com').pipe(fetch);
      setTimeout(() => controller.abort(), 20);

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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

    it('should allow withAuth without a registered retry middleware', async () => {
      // Regression: withAuth's `inner: 'builtin:retry'` reference with no
      // retry registered used to trip a fake "dependency cycle" error.
      const order: string[] = [];
      const tracking: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('anon-in');
          const res = await f(...params);
          order.push('anon-out');
          return res;
        };
      let capturedAuth: string | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
        return Promise.resolve(new Response('ok'));
      });

      const client = create({ fetch: mockFetch as any })
        .pipe(use, withAuth('token-only'))
        .pipe(use, tracking);

      const response = await client
        .pipe(url, 'https://example.com')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(capturedAuth).toBe('Bearer token-only');
      expect(order).toEqual(['anon-in', 'anon-out']);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
