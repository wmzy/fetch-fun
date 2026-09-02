import type { MiddlewareFn, StandardSchema } from '@/types';

import { afterEach, describe, it, vi, expect } from 'vitest';

import {
  create,
  url,
  fetch,
  fetchData,
  fetchJSON,
  use,
  json,
  text,
  validate,
  checkError,
  mapResponse,
  mapError,
  retry,
  signal,
  HTTPError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from '@/index';
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

    it('should not wrap a TypeError thrown by user middleware as NetworkError', async () => {
      // Only TypeErrors from the base fetch itself may become NetworkError;
      // a TypeError escaping user middleware keeps its original identity.
      const thrown = new TypeError('middleware type error');
      const errorMiddleware: MiddlewareFn = () => async () => {
        throw thrown;
      };

      const mockFetch = vi.fn();

      const client = create({ fetch: mockFetch })
        .pipe(use, errorMiddleware);

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com').pipe(fetch);
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBe(thrown);
      expect(err).not.toBeInstanceOf(NetworkError);
      expect(mockFetch).not.toHaveBeenCalled();
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
    it('should not retry when checkError throws (non-retryable status)', async () => {
      // New smart-retry semantics: a resolved response is only retried
      // when its status is in the retryable set. A 404 is not, so retry
      // passes it through untouched and the checkError throw (outer
      // middleware, never seen by retry) surfaces after a single attempt.
      // (A 500 here would now be retried first — intended behavior.)
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
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

    it('should retry NetworkError and surface it after exhausting attempts', async () => {
      const original = new TypeError('fetch failed');
      const mockFetch = vi.fn().mockRejectedValue(original);

      const client = create({ fetch: mockFetch }).pipe(retry, 2, {
        delay: { initial: 1, max: 1, multiplier: 1 },
      });

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/flaky').pipe(fetch);
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).cause).toBe(original);
      expect((err as NetworkError).url).toBe('https://example.com/flaky');
      // Network failures are transient by default: initial attempt + 2 retries.
      expect(mockFetch).toHaveBeenCalledTimes(3);
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

  describe('HTTP error handling', () => {
    it('should handle 404 error from HTTP request', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 404 }));

      const client = create({ fetch: mockFetch }).pipe(
        checkError,
        (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      );

      await expect(
        client.pipe(url, 'https://example.com/status/404').pipe(fetch)
      ).rejects.toThrow('HTTP 404');
    });

    it('should handle 500 error from HTTP request', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 500 }));

      const client = create({ fetch: mockFetch }).pipe(
        checkError,
        (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      );

      await expect(
        client.pipe(url, 'https://example.com/status/500').pipe(fetch)
      ).rejects.toThrow('HTTP 500');
    });

    it('should reject fetchJSON with HTTPError on 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
        })
      );

      const client = create({ fetch: mockFetch });

      let err: unknown;
      try {
        await client
          .pipe(url, 'https://example.com/users/1')
          .pipe(fetchJSON);
        expect.unreachable('fetchJSON should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(HTTPError);
      expect((err as HTTPError).name).toBe('HTTPError');
      expect((err as HTTPError).response.status).toBe(404);
      expect((err as HTTPError).data).toEqual({ message: 'Not Found' });
      expect((err as HTTPError).message).toContain('status 404');
      expect((err as HTTPError).request?.url).toBe(
        'https://example.com/users/1'
      );
    });

    it('should reject fetchData with HTTPError on 500', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('internal error', { status: 500 }));

      const client = create({ fetch: mockFetch }).pipe(text);

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/boom').pipe(fetchData);
        expect.unreachable('fetchData should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(HTTPError);
      expect((err as HTTPError).response.status).toBe(500);
      expect((err as HTTPError).data).toBe('internal error');
    });

    it('should resolve fetchJSON with parsed data on 200', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [1, 2] }), { status: 200 })
      );

      const client = create({ fetch: mockFetch });

      const result = await client
        .pipe(url, 'https://example.com/list')
        .pipe(fetchJSON<{ items: number[] }>);

      expect(result).toEqual({ items: [1, 2] });
    });

    it('should resolve fetch() with the raw response on 404 (escape hatch)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = create({ fetch: mockFetch }).pipe(json);

      const res = await client
        .pipe(url, 'https://example.com/raw')
        .pipe(fetch);

      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
      expect(getData(res)).toEqual({ error: 'Not Found' });
    });

    it('should propagate custom checkError error instead of HTTPError', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
        })
      );

      const client = create({ fetch: mockFetch }).pipe(
        checkError,
        (res) => {
          if (!res.ok) throw new Error(`custom ${res.status}`);
        }
      );

      await expect(
        client.pipe(url, 'https://example.com/checked').pipe(fetchJSON)
      ).rejects.toThrow('custom 404');
    });

    it('should reject fetch() with NetworkError wrapping the original TypeError', async () => {
      const original = new TypeError('fetch failed');
      const mockFetch = vi.fn().mockRejectedValue(original);

      const client = create({ fetch: mockFetch });

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/down').pipe(fetch);
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).toBeInstanceOf(Error);
      expect((err as NetworkError).name).toBe('NetworkError');
      expect((err as NetworkError).url).toBe('https://example.com/down');
      expect((err as NetworkError).cause).toBe(original);
      expect((err as NetworkError).message).toBe(
        'GET https://example.com/down failed: network error'
      );
    });

    it('should reject fetchJSON() with NetworkError on the same conditions', async () => {
      const original = new TypeError('fetch failed');
      const mockFetch = vi.fn().mockRejectedValue(original);

      const client = create({ fetch: mockFetch });

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/users').pipe(fetchJSON);
        expect.unreachable('fetchJSON should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).url).toBe('https://example.com/users');
      expect((err as NetworkError).cause).toBe(original);
    });

    it('should let user aborts propagate as AbortError, not NetworkError', async () => {
      const controller = new AbortController();
      const mockFetch = vi
        .fn()
        .mockImplementation(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(
                  new DOMException('This operation was aborted', 'AbortError')
                );
              });
            })
        );

      const client = create({ fetch: mockFetch });

      const pending = client
        .pipe(url, 'https://example.com/slow')
        .pipe(signal, controller.signal)
        .pipe(fetch);

      // Real timers: fire the abort while the request is in flight.
      setTimeout(() => controller.abort(), 20);

      let err: unknown;
      try {
        await pending;
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(NetworkError);
    });

    it('should not wrap a TypeError when the request signal already aborted', async () => {
      // Some runtimes reject with a TypeError around an abort; an aborted
      // signal must keep the rejection untouched instead of mislabeling it.
      const controller = new AbortController();
      controller.abort();
      const thrown = new TypeError('terminated');
      const mockFetch = vi.fn().mockRejectedValue(thrown);

      const client = create({ fetch: mockFetch });

      let err: unknown;
      try {
        await client
          .pipe(url, 'https://example.com/gone')
          .pipe(signal, controller.signal)
          .pipe(fetch);
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBe(thrown);
      expect(err).not.toBeInstanceOf(NetworkError);
    });

    it('should let non-TypeError fetch failures propagate unchanged', async () => {
      const thrown = new Error('unexpected implementation error');
      const mockFetch = vi.fn().mockRejectedValue(thrown);

      const client = create({ fetch: mockFetch });

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/weird').pipe(fetch);
        expect.unreachable('fetch should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBe(thrown);
      expect(err).not.toBeInstanceOf(NetworkError);
    });

    it('should export HTTPError and TimeoutError from the library entry', () => {
      const httpErr = new HTTPError(
        new Response(null, { status: 404, statusText: 'Not Found' }),
        new Request('https://example.com/x')
      );
      expect(httpErr.name).toBe('HTTPError');
      expect(httpErr.message).toBe(
        'GET https://example.com/x failed with status 404 Not Found'
      );
      expect(httpErr.data).toBeUndefined();

      // Empty statusText must not leave a trailing space in the message.
      const terse = new HTTPError(
        new Response(null, { status: 500, statusText: '' }),
        new Request('https://example.com/y')
      );
      expect(terse.message).toBe(
        'GET https://example.com/y failed with status 500'
      );

      const networkErr = new NetworkError('https://api.example.com/x', {
        method: 'POST',
        cause: new TypeError('fetch failed'),
      });
      expect(networkErr.name).toBe('NetworkError');
      expect(networkErr.message).toBe(
        'POST https://api.example.com/x failed: network error'
      );
      expect(networkErr.cause).toBeInstanceOf(TypeError);

      const bare = new NetworkError();
      expect(bare.message).toBe('network error');
      expect(bare.url).toBeUndefined();

      const timeoutErr = new TimeoutError();
      expect(timeoutErr.name).toBe('TimeoutError');
      expect(timeoutErr.message).toBe('Request timed out');
      expect(timeoutErr).toBeInstanceOf(Error);
    });

    it('serializes every error class to a plain object via toJSON', () => {
      // A Response built by the constructor has url '' (only fetch-returned
      // responses carry the final URL) — the field is passed through as-is.
      const httpErr = new HTTPError(
        new Response(null, { status: 404, statusText: 'Not Found' })
      );
      httpErr.data = { message: 'Not Found' };
      expect(JSON.parse(JSON.stringify(httpErr))).toEqual({
        name: 'HTTPError',
        message: 'GET  failed with status 404 Not Found',
        status: 404,
        url: '',
        data: { message: 'Not Found' },
      });
      // No live Response/Request bodies leak into the serialized form.
      expect(JSON.stringify(httpErr)).not.toContain('"response"');
      expect(JSON.stringify(httpErr)).not.toContain('"request"');
      // toJSON lives on the prototype — no other property becomes enumerable.
      expect(Object.prototype.propertyIsEnumerable.call(httpErr, 'toJSON')).toBe(false);

      const networkErr = new NetworkError('https://api.example.com/x', {
        method: 'POST',
        cause: new TypeError('fetch failed'),
      });
      expect(JSON.parse(JSON.stringify(networkErr))).toEqual({
        name: 'NetworkError',
        message: 'POST https://api.example.com/x failed: network error',
        url: 'https://api.example.com/x',
        cause: { name: 'TypeError', message: 'fetch failed' },
      });
      // Non-Error causes are dropped instead of leaking opaque values.
      const stringCause = new NetworkError('https://api.example.com/y', {
        cause: 'just a string',
      });
      expect(JSON.parse(JSON.stringify(stringCause)).cause).toBeUndefined();

      const timeoutErr = new TimeoutError('Request timed out after 30ms', {
        cause: new DOMException('signal timed out', 'TimeoutError'),
      });
      expect(JSON.parse(JSON.stringify(timeoutErr))).toEqual({
        name: 'TimeoutError',
        message: 'Request timed out after 30ms',
        cause: { name: 'TimeoutError', message: 'signal timed out' },
      });

      const validationErr = new ValidationError(
        [{ message: 'Expected string, got number' }],
        42
      );
      expect(JSON.parse(JSON.stringify(validationErr))).toEqual({
        name: 'ValidationError',
        message: 'Expected string, got number',
        issues: [{ message: 'Expected string, got number' }],
        data: 42,
      });
    });

    it('omits undefined data from the serialized HTTPError shape', () => {
      const httpErr = new HTTPError(
        new Response(null, { status: 500, statusText: '' }),
        new Request('https://example.com/y')
      );
      const parsed = JSON.parse(JSON.stringify(httpErr));
      expect(parsed).toEqual({
        name: 'HTTPError',
        message: 'GET https://example.com/y failed with status 500',
        status: 500,
        url: '',
      });
      expect(parsed.data).toBeUndefined();
    });

    it('exposes the status shorthand and withMessage preserves the error type', () => {
      const response = new Response(null, {
        status: 401,
        statusText: 'Unauthorized',
      });
      const request = new Request('https://example.com/session');
      const original = new HTTPError(response, request, {
        cause: new Error('boom'),
      });
      original.data = { message: 'token expired' };

      // Shorthand for response.status.
      expect(original.status).toBe(401);

      const rewritten = original.withMessage('Session expired, please log in');
      expect(rewritten).toBeInstanceOf(HTTPError);
      expect(rewritten).not.toBe(original);
      expect(rewritten.message).toBe('Session expired, please log in');
      expect(rewritten.status).toBe(401);
      expect(rewritten.response).toBe(response);
      expect(rewritten.request).toBe(request);
      expect(rewritten.data).toEqual({ message: 'token expired' });
      expect((rewritten.cause as Error).message).toBe('boom');

      // The original error is untouched — still carries its own message.
      expect(original.message).toContain('status 401');
    });

    it('withMessage inherits fields added after construction via the prototype', () => {
      const original = new HTTPError(
        new Response(null, { status: 418, statusText: "I'm a teapot" })
      );
      // A field this version of the class knows nothing about — attached
      // by user middleware, a subclass, or future library versions. The
      // old field-copying clone would have dropped it.
      (original as unknown as Record<string, unknown>).correlationId =
        'abc-123';

      const clone = original.withMessage('teapot');

      // Identity, accessors, and methods all survive the prototype clone.
      expect(clone).toBeInstanceOf(HTTPError);
      expect(clone).not.toBe(original);
      expect(clone.status).toBe(418);
      expect(clone.response).toBe(original.response);
      expect(clone.message).toBe('teapot');
      expect(clone.toJSON()).toMatchObject({
        name: 'HTTPError',
        status: 418,
        message: 'teapot',
      });
      // The unknown field is visible on the clone without HTTPError
      // knowing it exists…
      expect(
        (clone as unknown as Record<string, unknown>).correlationId
      ).toBe('abc-123');
      // …and keeps working through chained clones and methods.
      const twice = clone.withMessage('short and stout');
      expect(twice).toBeInstanceOf(HTTPError);
      expect(twice.message).toBe('short and stout');
      expect(
        (twice as unknown as Record<string, unknown>).correlationId
      ).toBe('abc-123');
      // The original is untouched.
      expect(original.message).toContain('418');
    });

    it('withMessage preserves subclass identity and subclass fields', () => {
      class TaggedHTTPError extends HTTPError {
        tag = 'from-checkError';
      }
      const sub = new TaggedHTTPError(
        new Response(null, { status: 503, statusText: 'Service Unavailable' })
      );

      const clone = sub.withMessage('degraded');
      expect(clone).toBeInstanceOf(TaggedHTTPError);
      expect(clone).toBeInstanceOf(HTTPError);
      expect((clone as TaggedHTTPError).tag).toBe('from-checkError');
      expect(clone.status).toBe(503);
    });

    it('withMessage shares the original stack instead of capturing a new one', () => {
      const original = new HTTPError(
        new Response(null, { status: 500, statusText: '' })
      );
      const clone = original.withMessage('rewritten');
      // Documented behavior: the clone inherits the original's stack (the
      // original construction site), it does not capture a fresh one at
      // the withMessage call.
      expect(clone.stack).toBe(original.stack);
    });

    it('withMessage in mapError keeps instanceof/status/data for downstream handlers', async () => {
      // The documented pattern: rewrite the message from the parsed body,
      // keep everything the global handlers branch on.
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ errors: { token: ['expired'] } }), {
          status: 401,
        })
      );

      const client = create({ fetch: mockFetch })
        .pipe(url, 'https://example.com/me')
        .pipe(mapError, (e: unknown) =>
          e instanceof HTTPError
            ? e.withMessage(
                String((e.data as { errors: Record<string, string[]> }).errors.token?.[0])
              )
            : e
        )
        .pipe(fetchJSON);

      let caught: unknown;
      try {
        await client;
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(HTTPError);
      expect((caught as HTTPError).message).toBe('expired');
      expect((caught as HTTPError).status).toBe(401);
      expect((caught as HTTPError).data).toEqual({ errors: { token: ['expired'] } });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('schema validation (Standard Schema v1)', () => {
    it('should resolve fetchData with the validated value and adopt result.value', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 1, name: 'ada' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const schema: StandardSchema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          // async validate must be awaited by the reader mapper
          validate: async (value: unknown) => {
            const v = value as { id: number; name: string };
            if (typeof v.id !== 'number' || typeof v.name !== 'string') {
              return { issues: [{ message: 'wrong shape' }] };
            }
            return { value: { ...v, validated: true } };
          },
        },
      };

      const client = create({ fetch: mockFetch })
        .pipe(validate, schema)
        .pipe(json);

      const result = await client
        .pipe(url, 'https://example.com/users/1')
        .pipe(fetchData);

      expect(result).toEqual({ id: 1, name: 'ada', validated: true });
    });

    it('should validate the parsed data regardless of pipe order', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ n: 7 }), { status: 200 }))
      );

      const seen: unknown[] = [];
      const schema: StandardSchema = {
        '~standard': {
          version: 1,
          validate: (value: unknown) => {
            seen.push(value);
            return { value: (value as { n: number }).n * 2 };
          },
        },
      };

      const base = create({ fetch: mockFetch });

      const afterReader = await base
        .pipe(url, 'https://example.com/a')
        .pipe(json)
        .pipe(validate, schema)
        .pipe(fetchData);
      const beforeReader = await base
        .pipe(url, 'https://example.com/b')
        .pipe(validate, schema)
        .pipe(json)
        .pipe(fetchData);

      expect(afterReader).toBe(14);
      expect(beforeReader).toBe(14);
      expect(seen).toEqual([{ n: 7 }, { n: 7 }]);
    });

    it('should reject fetchData with ValidationError when issues are present', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'nope' }), { status: 200 })
      );

      const issues = [{ message: 'id must be a number', path: ['id'] }];
      const schema: StandardSchema = {
        '~standard': {
          version: 1,
          validate: () => ({ issues }),
        },
      };

      const client = create({ fetch: mockFetch })
        .pipe(json)
        .pipe(validate, schema);

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/bad').pipe(fetchData);
        expect.unreachable('fetchData should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(Error);
      expect((err as ValidationError).name).toBe('ValidationError');
      expect((err as ValidationError).issues).toEqual(issues);
      expect((err as ValidationError).data).toEqual({ id: 'nope' });
      expect((err as ValidationError).message).toBe('id must be a number');
    });

    it('should throw HTTPError instead of ValidationError on 404 (validation skipped)', async () => {
      const validateFn = vi.fn(() => ({ value: undefined }));
      const schema: StandardSchema = {
        '~standard': { version: 1, validate: validateFn },
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
        })
      );

      const client = create({ fetch: mockFetch })
        .pipe(json)
        .pipe(validate, schema);

      let err: unknown;
      try {
        await client.pipe(url, 'https://example.com/missing').pipe(fetchData);
        expect.unreachable('fetchData should have rejected');
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(HTTPError);
      expect(err).not.toBeInstanceOf(ValidationError);
      expect((err as HTTPError).response.status).toBe(404);
      expect((err as HTTPError).data).toEqual({ message: 'Not Found' });
      expect(validateFn).not.toHaveBeenCalled();
    });

    it('should extract the ValidationError message from the first issue', () => {
      const err = new ValidationError(
        [{ message: 'Expected string, got number' }, { message: 'second' }],
        42
      );
      expect(err.name).toBe('ValidationError');
      expect(err.message).toBe('Expected string, got number');
      expect(err.issues).toHaveLength(2);
      expect(err.data).toBe(42);

      const bare = new ValidationError([{}], null);
      expect(bare.message).toBe('Response data failed validation');

      const none = new ValidationError([]);
      expect(none.message).toBe('Response data failed validation');

      const custom = new ValidationError([], undefined, 'custom message');
      expect(custom.message).toBe('custom message');
    });
  });
});
