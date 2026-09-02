import type { MiddlewareFn, MiddlewareEntry, StandardSchema } from '../src/types';

import { afterEach, beforeEach, describe, it, vi, expect } from 'vitest';

import {
  retry,
  create,
  createRetry,
  url,
  fetch,
  fetchData,
  fetchJSON,
  use,
  signal,
  method,
  body,
  checkError,
  json,
  validate,
  withRetry,
  withTimeout,
  withAuth,
  withLogging,
  withProgress,
  sortMiddlewares,
  normalizeMiddleware,
  NORMAL,
 TimeoutError, HTTPError, ValidationError, NetworkError } from '@/index';
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

    // The base fetch's TypeError surfaces as a NetworkError (cause kept).
    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow(NetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(3); // exhausted all attempts
  });

  it('should not retry a network error (TypeError) on POST', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 2, { delay: { initial: 1 } })
      .pipe(method, 'POST');

    await expect(
      client.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow(NetworkError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // immediate rethrow
  });

  it('should not retry a POST carried by a Request input (method not in init)', async () => {
    // Regression: reading only `init.method` classified a Request-carried
    // POST as the default GET and retried a non-idempotent request.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 }));
    const wrapped = createRetry(3, { delay: { initial: 1 } })(
      mockFetch as unknown as typeof globalThis.fetch,
      {} as Parameters<MiddlewareFn>[1]
    );

    const res = await wrapped(
      new Request('https://example.com/submit', { method: 'POST' })
    );

    expect(res.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Contrast: a Request-carried GET still retries on a transient status.
    const mockGet = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 503 }));
    const wrappedGet = createRetry(1, { delay: { initial: 1 } })(
      mockGet as unknown as typeof globalThis.fetch,
      {} as Parameters<MiddlewareFn>[1]
    );
    const pending = wrappedGet(new Request('https://example.com'));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toHaveProperty('status', 503);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('should stop retrying when the signal aborts during backoff (rejection path)', async () => {
    // `sleep` resolves on abort by design; without a follow-up check the
    // loop ran one more doomed attempt. Real timers: the backoff must not
    // advance under fake timers for the abort to land inside it.
    vi.useRealTimers();
    const controller = new AbortController();
    const mockFetch = vi.fn().mockRejectedValue(new Error('transient'));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 5000 } })
      .pipe(signal, controller.signal);

    const pending = client.pipe(url, 'https://example.com').pipe(fetch);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no post-abort attempt
  });

  it('should stop retrying when the signal aborts during backoff (response path)', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const client = create({ fetch: mockFetch })
      .pipe(retry, 3, { delay: { initial: 5000 } })
      .pipe(signal, controller.signal);

    const pending = client.pipe(url, 'https://example.com').pipe(fetch);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no post-abort attempt
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

  it('should cap a long Retry-After at maxRetryAfter', async () => {
    // Real timers: the wait must be measurable in real milliseconds.
    vi.useRealTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 429,
          headers: { 'Retry-After': '120' }, // demands 2 minutes
        })
      )
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      maxRetryAfter: 50,
    });

    const start = Date.now();
    const res = await client.pipe(url, 'https://example.com').pipe(fetch);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(40); // waited the 50ms cap…
    expect(elapsed).toBeLessThan(1000); // …not the 120s demand nor the 1s backoff
  });

  it('should let shouldRetry override the status set (retry a non-default status)', async () => {
    const seen: { response?: Response; error?: unknown }[] = [];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('teapot', { status: 418 }))
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      shouldRetry: (_attempt, result) => {
        seen.push(result);
        return result.response?.status === 418; // custom retryable set
      },
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Consulted for every resolved attempt within the budget — including
    // the successful 200, where it says "no" and the response is returned.
    expect(seen.map((r) => r.response?.status)).toEqual([418, 200]);
    expect(seen.every((r) => r.error === undefined)).toBe(true);
  });

  it('should let shouldRetry veto a default-retryable status', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok')); // must never be reached
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      shouldRetry: () => false,
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(503); // surfaced as-is instead of retried
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should await an async shouldRetry predicate (a vetoing Promise must not retry)', async () => {
    // An un-awaited predicate would yield a truthy Promise and retry
    // anyway; only proper awaiting sees the resolved `false`.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 503 }));
    const client = create({ fetch: mockFetch }).pipe(retry, 2, {
      shouldRetry: async () => false,
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should pass 0-indexed attempts and result.error on the rejection path', async () => {
    const seen: { attempt: number; error: unknown; response?: Response }[] =
      [];
    const first = new TypeError('fetch failed');
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(new TypeError('again'))
      .mockResolvedValueOnce(new Response('ok'));
    const client = create({ fetch: mockFetch }).pipe(retry, 3, {
      shouldRetry: async (attempt, result) => {
        seen.push({ attempt, error: result.error, response: result.response });
        return result.error !== undefined; // retry failures only
      },
      delay: { initial: 1 },
    });

    const res = await client.pipe(url, 'https://example.com').pipe(fetch);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Starts at 0 and increments; the final entry is the successful
    // attempt, where the predicate sees a response and vetoes the retry.
    expect(seen.map((s) => s.attempt)).toEqual([0, 1, 2]);
    // result.error is the thrown value — the base fetch's TypeError,
    // wrapped as a NetworkError with the original preserved as cause.
    expect(seen[0]!.error).toBeInstanceOf(NetworkError);
    expect((seen[0]!.error as NetworkError).cause).toBe(first);
    expect(seen.slice(0, 2).every((s) => s.response === undefined)).toBe(true);
    expect(seen[2]!.response?.status).toBe(200);
  });

  it('should enforce the method/count hard rules even when shouldRetry says yes', async () => {
    // Non-idempotent method: never retried despite the predicate.
    const postFetch = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const postClient = create({ fetch: postFetch })
      .pipe(retry, 3, { shouldRetry: () => true, delay: { initial: 1 } })
      .pipe(method, 'POST');

    const postRes = await postClient
      .pipe(url, 'https://example.com')
      .pipe(fetch);

    expect(postRes.status).toBe(500);
    expect(postFetch).toHaveBeenCalledTimes(1); // side-effect protection wins

    // Count gate: the budget is exhausted even though the predicate
    // keeps saying yes.
    const getFetch = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const getClient = create({ fetch: getFetch }).pipe(retry, 2, {
      shouldRetry: () => true,
      delay: { initial: 1 },
    });

    const getRes = await getClient.pipe(url, 'https://example.com').pipe(fetch);

    expect(getRes.status).toBe(500);
    expect(getFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, stop
  });

  it('should never retry asNotRetryError/ValidationError regardless of shouldRetry', async () => {
    // asNotRetryError: unwrapped original rethrown immediately.
    const original = new Error('permanent');
    const wrappedFetch = vi
      .fn()
      .mockRejectedValueOnce(asNotRetryError(original))
      .mockResolvedValueOnce(new Response('ok'));
    const wrappedClient = create({ fetch: wrappedFetch }).pipe(retry, 3, {
      shouldRetry: () => true,
      delay: { initial: 1 },
    });

    await expect(
      wrappedClient.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow('permanent');
    expect(wrappedFetch).toHaveBeenCalledTimes(1);

    // ValidationError: deterministic failure, retried by nothing.
    const validationFetch = vi
      .fn()
      .mockRejectedValueOnce(new ValidationError([{ message: 'nope' }]))
      .mockResolvedValueOnce(new Response('ok'));
    const validationClient = create({ fetch: validationFetch }).pipe(retry, 3, {
      shouldRetry: () => true,
      delay: { initial: 1 },
    });

    await expect(
      validationClient.pipe(url, 'https://example.com').pipe(fetch)
    ).rejects.toThrow(ValidationError);
    expect(validationFetch).toHaveBeenCalledTimes(1);
  });

  it('should surface HTTPError (not a reader SyntaxError) for non-2xx non-JSON bodies', async () => {
    // Regression: the data middleware's reader ran unconditionally, so an
    // HTML 500 page fed to the json reader threw SyntaxError before
    // fetchJSON's !res.ok -> HTTPError check could ever run.
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>Server Error</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const client = create({ fetch: mockFetch }).pipe(json);

    let caught: unknown;
    try {
      await client.pipe(url, 'https://example.com/boom').pipe(fetchJSON);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HTTPError);
    expect((caught as HTTPError).response.status).toBe(500);
    expect((caught as HTTPError).data).toBeUndefined();
  });

  it('should keep a parseable error body on HTTPError for non-2xx JSON bodies', async () => {
    // The non-2xx reader branch is best-effort: a body that does parse is
    // still stored so HTTPError.data carries the parsed error payload.
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'missing' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const client = create({ fetch: mockFetch }).pipe(json);

    let caught: unknown;
    try {
      await client.pipe(url, 'https://example.com/missing').pipe(fetchJSON);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HTTPError);
    expect((caught as HTTPError).response.status).toBe(404);
    expect((caught as HTTPError).data).toEqual({ error: 'missing' });
  });

  it('should resolve undefined for an empty-bodied 204 with json + fetchData', async () => {
    // A 204 has no body: json's empty-body guard must resolve undefined
    // instead of throwing SyntaxError('Unexpected end of JSON input').
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = create({ fetch: mockFetch }).pipe(json);

    const data = await client
      .pipe(url, 'https://example.com/nada')
      .pipe(fetchData);

    expect(data).toBeUndefined();
  });

  it('should skip schema validation on non-2xx and surface HTTPError', async () => {
    // A 500 must reject with HTTPError, never a ValidationError: the
    // schema is not even consulted for non-2xx responses.
    const validateSpy = vi.fn(() => ({ value: null }));
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: validateSpy,
      },
    } as const satisfies StandardSchema;
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const client = create({ fetch: mockFetch })
      .pipe(json)
      .pipe(validate, schema);

    let caught: unknown;
    try {
      await client.pipe(url, 'https://example.com/boom').pipe(fetchJSON);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HTTPError);
    expect(caught).not.toBeInstanceOf(ValidationError);
    expect((caught as HTTPError).response.status).toBe(500);
    expect(validateSpy).not.toHaveBeenCalled();
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
        signals.push(init!.signal);
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

      // withAuth normalizes headers into a Headers instance.
      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('Authorization')).toBe('Bearer my-token');
      expect(headers.get('X-Custom')).toBe('value');
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
        new Headers(capturedInit?.headers).get('Authorization')
      ).toBe('Bearer my-token');
    });

    it('withAuth middleware should preserve headers from a Headers instance', async () => {
      // Regression: the old plain-object spread saw a Headers instance as
      // `{}` and silently dropped every header it carried.
      const config = withAuth('my-token');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', {
        headers: new Headers({ 'X-Custom': 'value', Accept: 'text/plain' }),
      });

      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('Authorization')).toBe('Bearer my-token');
      expect(headers.get('X-Custom')).toBe('value');
      expect(headers.get('Accept')).toBe('text/plain');
    });

    it('withAuth should support Basic type via template, matching config-side auth()', async () => {
      // No automatic base64: like auth(o, type, credentials), the value is
      // the plain `${type} ${credentials}` template.
      const config = withAuth('user:pass', 'Basic');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(
        new Headers(capturedInit?.headers).get('Authorization')
      ).toBe('Basic user:pass');
    });

    it('withAuth should default to Bearer when type is omitted (regression)', async () => {
      const config = withAuth('my-token');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(
        new Headers(capturedInit?.headers).get('Authorization')
      ).toBe('Bearer my-token');
    });

    it('withAuth should pass through a custom scheme type verbatim', async () => {
      const config = withAuth('ticket-abc', 'HOBA');
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(
        new Headers(capturedInit?.headers).get('Authorization')
      ).toBe('HOBA ticket-abc');
    });

    it('withLogging middleware should log request and response', async () => {
      const logs: { msg: string; data?: unknown }[] = [];
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
      const logs: { msg: string; data?: unknown }[] = [];
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

    it('withAuth should re-evaluate a function token on every call (each attempt gets the latest token)', async () => {
      const tokens = ['token-v1', 'token-v2'];
      let calls = 0;
      const seen: string[] = [];
      const mockFetch = vi.fn().mockImplementation((_input, init) => {
        // Two direct calls stand in for request + retry replay; the
        // supplier must be consulted again on the second attempt.
        seen.push(new Headers(init?.headers).get('authorization')!);
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth(() => tokens[calls++]!);
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);
      await wrappedFetch('https://example.com', undefined);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(seen).toEqual(['Bearer token-v1', 'Bearer token-v2']);
    });

    it('withAuth should await an async token supplier', async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_input, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth(async () => {
        // Microtask hop: the returned promise must actually be awaited
        // (a leaked unawaited promise would resolve after the assert).
        await Promise.resolve();
        return 'async-jwt';
      });
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(
        new Headers(capturedInit?.headers).get('authorization')
      ).toBe('Bearer async-jwt');
    });

    it('withAuth static string credentials stay unchanged across calls (no regression)', async () => {
      const seen: string[] = [];
      const mockFetch = vi.fn().mockImplementation((_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization')!);
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth('static-token');
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);
      await wrappedFetch('https://example.com', undefined);

      expect(seen).toEqual(['Bearer static-token', 'Bearer static-token']);
    });

    it('withAuth should skip the header when a supplier returns an empty string', async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth(() => '');
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      // No empty "Bearer " header is sent.
      expect(new Headers(capturedInit?.headers).get('Authorization')).toBeNull();
    });

    it('withAuth should skip the header when a supplier returns null or undefined (async too)', async () => {
      const seen: (string | null)[] = [];
      const mockFetch = vi.fn().mockImplementation((_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return Promise.resolve(new Response('ok'));
      });

      for (const config of [
        withAuth(() => undefined),
        withAuth(() => null),
        withAuth(async () => undefined),
      ]) {
        const wrappedFetch = config.middleware(mockFetch as any, {} as any);
        await wrappedFetch('https://example.com', undefined);
      }

      expect(seen).toEqual([null, null, null]);
    });

    it('withAuth should treat a whitespace-only credentials string as empty', async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth(() => '   ');
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', undefined);

      expect(new Headers(capturedInit?.headers).get('Authorization')).toBeNull();
    });

    it('withAuth should drop an inherited Authorization header when credentials are empty', async () => {
      // A shared client may carry a default Authorization (e.g. a stale
      // token via header()); an empty supplier must not leave it behind.
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedInit = init;
        return Promise.resolve(new Response('ok'));
      });

      const config = withAuth(() => undefined);
      const wrappedFetch = config.middleware(mockFetch as any, {} as any);
      await wrappedFetch('https://example.com', {
        headers: { Authorization: 'Bearer stale-token', 'X-Custom': 'value' },
      });

      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('X-Custom')).toBe('value');
    });
  });

  describe('withProgress', () => {
    it('withProgress should create config with inner NORMAL constraint', () => {
      const config = withProgress({});
      expect(config.name).toBe('builtin:progress');
      expect(config.inner).toBe(NORMAL);
    });

    it('withProgress middleware should report download progress per chunk', async () => {
      const enc = new TextEncoder();
      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('Hello'));
          c.enqueue(enc.encode('World'));
          c.close();
        },
      });
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(bodyStream, { headers: { 'Content-Length': '10' } })
        );
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const chunks: Uint8Array[] = [];
      const config = withProgress({
        onDownloadProgress: (p, chunk) => {
          events.push({ ...p });
          chunks.push(chunk);
        },
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );
      const res = await wrappedFetch('https://example.com');
      const text = await res.text();

      expect(text).toBe('HelloWorld');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.transferred)).toEqual([5, 10]);
      expect(events.map((e) => e.total)).toEqual([10, 10]);
      expect(events.map((e) => e.percent)).toEqual([0.5, 1]);

      // The chunks handed to the callback concatenate back to the body.
      const merged = chunks.reduce<Uint8Array>((acc, c) => {
        const out = new Uint8Array(acc.byteLength + c.byteLength);
        out.set(acc);
        out.set(c, acc.byteLength);
        return out;
      }, new Uint8Array(0));
      expect(new TextDecoder().decode(merged)).toBe('HelloWorld');
    });

    it('withProgress should keep percent 0 but still count bytes without Content-Length', async () => {
      const enc = new TextEncoder();
      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('abc'));
          c.enqueue(enc.encode('de'));
          c.close();
        },
      });
      const mockFetch = vi.fn().mockResolvedValue(new Response(bodyStream));
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const config = withProgress({
        onDownloadProgress: (p) => events.push({ ...p }),
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );
      const res = await wrappedFetch('https://example.com');

      expect(await res.text()).toBe('abcde');
      expect(events.map((e) => e.transferred)).toEqual([3, 5]);
      expect(events.map((e) => e.total)).toEqual([0, 0]);
      expect(events.map((e) => e.percent)).toEqual([0, 0]);
    });

    it('withProgress should not wrap a null-body (204) response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      const onDownloadProgress = vi.fn();
      const config = withProgress({ onDownloadProgress });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );
      const res = await wrappedFetch('https://example.com');

      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
      expect(await res.text()).toBe('');
      expect(onDownloadProgress).not.toHaveBeenCalled();
    });

    it('withProgress should rebuild the response preserving status, statusText and headers', async () => {
      const enc = new TextEncoder();
      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('ok'));
          c.close();
        },
      });
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(bodyStream, {
          status: 201,
          statusText: 'Created',
          headers: { 'X-Custom': 'kept', 'Content-Type': 'text/plain' },
        })
      );
      const config = withProgress({
        onDownloadProgress: () => undefined,
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'GET' } as any
      );
      const res = await wrappedFetch('https://example.com');

      expect(res.status).toBe(201);
      expect(res.statusText).toBe('Created');
      expect(res.headers.get('X-Custom')).toBe('kept');
      expect(res.headers.get('Content-Type')).toBe('text/plain');
      expect(await res.text()).toBe('ok');
    });

    it('withProgress middleware should count a ReadableStream request body', async () => {
      const enc = new TextEncoder();
      const upload = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('abc'));
          c.enqueue(enc.encode('defg'));
          c.close();
        },
      });
      const mockFetch = vi
        .fn()
        .mockImplementation((_input, init) => new Response(init!.body));
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const config = withProgress({
        onUploadProgress: (p) => events.push({ ...p }),
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      const res = await wrappedFetch('https://example.com', {
        method: 'POST',
        body: upload,
      });

      expect(await res.text()).toBe('abcdefg');
      expect(events.map((e) => e.transferred)).toEqual([3, 7]);
      // A stream body has no known length: percent stays 0, total stays 0.
      expect(events.every((e) => e.percent === 0 && e.total === 0)).toBe(true);
      // fetch received a wrapped stream, not the original one.
      expect(mockFetch.mock.calls[0]![1].body).not.toBe(upload);
    });

    it('withProgress middleware should not fire onUploadProgress for a string body', async () => {
      const onUploadProgress = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const config = withProgress({ onUploadProgress });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: 'plain',
      });

      expect(onUploadProgress).not.toHaveBeenCalled();
      // Non-stream bodies pass through untouched.
      expect(mockFetch.mock.calls[0]![1].body).toBe('plain');
    });

    it('withProgress wrapBody should count a string body with a real total', async () => {
      vi.useRealTimers();
      const payload = 'héllo wörld'; // multi-byte: total must be UTF-8 bytes
      const seen: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        // Consume the wrapped stream so the counting transform runs.
        seen.push(await new Response(init!.body).text());
        return new Response('ok');
      });
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: (p) => events.push({ ...p }),
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: payload,
      });

      expect(seen).toEqual([payload]);
      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1]!;
      expect(last.total).toBe(new TextEncoder().encode(payload).byteLength);
      expect(last.transferred).toBe(last.total);
      expect(last.percent).toBe(1);
      // The body reached fetch as a counting stream with duplex set.
      expect(mockFetch.mock.calls[0]![1].body).toBeInstanceOf(ReadableStream);
      expect(mockFetch.mock.calls[0]![1].duplex).toBe('half');
    });

    it('withProgress wrapBody should not override an explicit Content-Type', async () => {
      vi.useRealTimers();
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: () => undefined,
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });

      const init = mockFetch.mock.calls[0]![1];
      expect(new Headers(init.headers).get('Content-Type')).toBe(
        'application/json'
      );
      expect(init.body).toBeInstanceOf(ReadableStream);
    });

    it('withProgress wrapBody should add the implicit text/plain Content-Type for a bare string', async () => {
      vi.useRealTimers();
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: () => undefined,
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: 'plain text',
      });

      expect(
        new Headers(mockFetch.mock.calls[0]![1].headers).get('Content-Type')
      ).toBe('text/plain;charset=UTF-8');
    });

    it('withProgress wrapBody should add the implicit form Content-Type for URLSearchParams', async () => {
      vi.useRealTimers();
      const seen: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        seen.push(await new Response(init!.body).text());
        return new Response('ok');
      });
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: () => undefined,
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: new URLSearchParams({ a: '1', b: '2' }),
      });

      expect(seen).toEqual(['a=1&b=2']);
      expect(
        new Headers(mockFetch.mock.calls[0]![1].headers).get('Content-Type')
      ).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    });

    it('withProgress wrapBody should count a Blob body without adding Content-Type', async () => {
      vi.useRealTimers();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const blob = new Blob([bytes]); // typeless: no implicit Content-Type
      const seen: number[][] = [];
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        const buf = new Uint8Array(
          await new Response(init!.body).arrayBuffer()
        );
        seen.push(Array.from(buf));
        return new Response('ok');
      });
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: (p) => events.push({ ...p }),
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: blob,
      });

      expect(seen).toEqual([[1, 2, 3, 4, 5]]);
      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1]!;
      expect(last.total).toBe(5);
      expect(last.transferred).toBe(5);
      expect(last.percent).toBe(1);
      expect(
        new Headers(mockFetch.mock.calls[0]![1].headers).get('Content-Type')
      ).toBeNull();
      expect(mockFetch.mock.calls[0]![1].duplex).toBe('half');
    });

    it('withProgress wrapBody should keep using the stream path for a ReadableStream body', async () => {
      vi.useRealTimers();
      const enc = new TextEncoder();
      const upload = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('abc'));
          c.close();
        },
      });
      const mockFetch = vi
        .fn()
        .mockImplementation((_input, init) => new Response(init!.body));
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];
      const config = withProgress({
        wrapBody: true,
        onUploadProgress: (p) => events.push({ ...p }),
      });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      const res = await wrappedFetch('https://example.com', {
        method: 'POST',
        body: upload,
      });

      expect(await res.text()).toBe('abc');
      expect(events.map((e) => e.transferred)).toEqual([3]);
      // Stream length stays unknown even with wrapBody enabled.
      expect(events.every((e) => e.total === 0 && e.percent === 0)).toBe(true);
      // fetch received a wrapped stream, not the original one.
      expect(mockFetch.mock.calls[0]![1].body).not.toBe(upload);
    });

    it('withProgress wrapBody false should pass a string body through untouched', async () => {
      const onUploadProgress = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const config = withProgress({ wrapBody: false, onUploadProgress });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: 'plain',
      });

      const init = mockFetch.mock.calls[0]![1];
      expect(init.body).toBe('plain');
      expect(init.duplex).toBeUndefined();
      expect(onUploadProgress).not.toHaveBeenCalled();
    });

    it('withProgress wrapBody should not wrap a FormData body', async () => {
      const form = new FormData();
      form.append('key', 'value');
      const onUploadProgress = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const config = withProgress({ wrapBody: true, onUploadProgress });

      const wrappedFetch = config.middleware(
        mockFetch as any,
        { url: '/test', method: 'POST' } as any
      );
      await wrappedFetch('https://example.com', {
        method: 'POST',
        body: form,
      });

      const init = mockFetch.mock.calls[0]![1];
      expect(init.body).toBe(form);
      expect(init.duplex).toBeUndefined();
      expect(onUploadProgress).not.toHaveBeenCalled();
    });
  });

  describe('use with MiddlewareConfig', () => {
    it('should accept simple middleware function', () => {
      const fn: MiddlewareFn = (f) => f;
      const client = use({}, fn);

      expect(client.middlewares).toHaveLength(1);
      expect(client.middlewares[0].middleware).toBe(fn);
    });

    it('should accept middleware config object', () => {
      const config = withRetry(3);
      const client = use({}, config);

      expect(client.middlewares).toHaveLength(1);
      expect(client.middlewares[0].name).toBe('builtin:retry');
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
        capturedAuth = new Headers(init?.headers).get('Authorization') ?? undefined;
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

    it('should order withProgress inside named and anonymous NORMAL middlewares', async () => {
      const enc = new TextEncoder();
      const upload = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('x'));
          c.close();
        },
      });
      const order: string[] = [];
      const named: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('named-in');
          const res = await f(...params);
          order.push('named-out');
          return res;
        };
      const anon: MiddlewareFn =
        (f) =>
        async (...params) => {
          order.push('anon-in');
          const res = await f(...params);
          order.push('anon-out');
          return res;
        };
      // Consuming the wrapped upload body inside the mock makes the upload
      // progress fire within the chain, between the middlewares that
      // surround progress.
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        await new Response(init!.body).text();
        return new Response('ok');
      });

      const client = create({ fetch: mockFetch as any })
        .pipe(use, { name: 'named', outer: NORMAL, middleware: named })
        .pipe(use, withProgress({ onUploadProgress: () => order.push('upload') }))
        .pipe(use, anon);

      const response = await client
        .pipe(url, 'https://example.com')
        .pipe(method, 'POST')
        .pipe(body, upload)
        .pipe(fetch);

      expect(await response.text()).toBe('ok');
      expect(order).toEqual([
        'named-in',
        'anon-in',
        'upload',
        'anon-out',
        'named-out',
      ]);
    });

    it('should restart download progress counters on each retry attempt', async () => {
      // Real timers: retry's backoff sleep must actually elapse (fake
      // timers leak from the "Middleware Tests" describe above).
      vi.useRealTimers();
      const enc = new TextEncoder();
      const makeBody = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('one'));
            c.enqueue(enc.encode('two'));
            c.close();
          },
        });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockResolvedValueOnce(
          new Response(makeBody(), { headers: { 'Content-Length': '6' } })
        );
      const events: {
        percent: number;
        transferred: number;
        total: number;
      }[] = [];

      const client = create({ fetch: mockFetch as any })
        .pipe(use, withRetry(1, { delay: { initial: 1 } }))
        .pipe(
          use,
          withProgress({
            onDownloadProgress: (p) => events.push({ ...p }),
          })
        );

      const res = await client
        .pipe(url, 'https://example.com')
        .pipe(fetch);

      expect(await res.text()).toBe('onetwo');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Progress sits inside retry: the discarded 503 attempt's cancelled
      // body reports nothing, and the successful attempt counts from zero.
      expect(events.map((e) => e.transferred)).toEqual([3, 6]);
      expect(events.map((e) => e.percent)).toEqual([0.5, 1]);
    });
  });
});
