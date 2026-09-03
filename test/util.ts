import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  sleep,
  retry,
  backoffDelay,
  parseRetryAfter,
  asNotRetryError,
  isNotRetryError,
  createQuery,
  getData,
  setData,
  hasData,
  applyTimeout,
  applyTotalTimeout,
} from '@/util';
import { TimeoutError } from '@/errors';
import { notRetryErrorSymbol } from '@/constants';

describe('Util Functions', () => {
  describe('sleep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should resolve after specified milliseconds', async () => {
      const promise = sleep(1000);
      vi.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    });

    it('should resolve immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const startTime = Date.now();
      await sleep(1000, controller.signal);
      const endTime = Date.now();

      // Should resolve immediately, not wait 1000ms
      expect(endTime - startTime).toBeLessThan(100);
    });

    it('should resolve early when signal is aborted', async () => {
      const controller = new AbortController();
      const promise = sleep(1000, controller.signal);

      // Abort after 500ms
      vi.advanceTimersByTime(500);
      controller.abort();

      await expect(promise).resolves.toBeUndefined();
    });

    it('should cleanup abort listener after completion', async () => {
      const controller = new AbortController();
      const promise = sleep(100, controller.signal);

      vi.advanceTimersByTime(100);
      await promise;

      // Should not throw when aborting after completion
      expect(() => controller.abort()).not.toThrow();
    });
  });

  describe('retry', () => {
    it('should return result on first success', async () => {
      const task = vi.fn().mockResolvedValue('success');
      const beforeRetry = vi.fn();

      const result = await retry(task, beforeRetry);

      expect(result).toBe('success');
      expect(task).toHaveBeenCalledTimes(1);
      expect(beforeRetry).not.toHaveBeenCalled();
    });

    it('should retry on failure and eventually succeed', async () => {
      const task = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const beforeRetry = vi.fn().mockResolvedValue(undefined);

      const result = await retry(task, beforeRetry);

      expect(result).toBe('success');
      expect(task).toHaveBeenCalledTimes(3);
      expect(beforeRetry).toHaveBeenCalledTimes(2);
    });

    it('should stop retrying when beforeRetry throws', async () => {
      const error = new Error('persistent failure');
      const task = vi.fn().mockRejectedValue(error);
      const maxRetries = 2;
      const beforeRetry = vi.fn().mockImplementation(async (attempt) => {
        if (attempt >= maxRetries) {
          throw error;
        }
      });

      await expect(retry(task, beforeRetry)).rejects.toThrow(
        'persistent failure'
      );

      expect(task).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(beforeRetry).toHaveBeenCalledTimes(3);
    });

    it('should call beforeRetry with correct arguments', async () => {
      const error = new Error('test error');
      const task = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');
      const beforeRetry = vi.fn().mockResolvedValue(undefined);

      await retry(task, beforeRetry);

      expect(beforeRetry).toHaveBeenCalledWith(0, error);
    });

    it('should increment attempt on each retry', async () => {
      const task = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockResolvedValue('success');

      const attempts: number[] = [];
      const beforeRetry = vi.fn().mockImplementation(async (attempt) => {
        attempts.push(attempt);
      });

      await retry(task, beforeRetry);

      expect(attempts).toEqual([0, 1, 2]);
    });
  });

  describe('backoffDelay', () => {
    it('should calculate exponential delay', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // No jitter (0.5 * 2 - 1 = 0)

      expect(backoffDelay(0, 100, 10000, 2)).toBe(100); // 100 * 2^0 = 100
      expect(backoffDelay(1, 100, 10000, 2)).toBe(200); // 100 * 2^1 = 200
      expect(backoffDelay(2, 100, 10000, 2)).toBe(400); // 100 * 2^2 = 400
      expect(backoffDelay(3, 100, 10000, 2)).toBe(800); // 100 * 2^3 = 800

      vi.restoreAllMocks();
    });

    it('should cap delay at maxDelay', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      // 100 * 2^10 = 102400, but maxDelay is 1000
      expect(backoffDelay(10, 100, 1000, 2)).toBe(1000);

      vi.restoreAllMocks();
    });

    it('should add jitter within ±25% range', () => {
      const initialDelay = 1000;
      const maxDelay = 10000;
      const multiplier = 2;

      // Test with random = 0 (minimum jitter: -25%)
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const minResult = backoffDelay(0, initialDelay, maxDelay, multiplier);
      expect(minResult).toBe(750); // 1000 - 250

      // Test with random = 1 (maximum jitter: +25%)
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const maxResult = backoffDelay(0, initialDelay, maxDelay, multiplier);
      expect(maxResult).toBe(1250); // 1000 + 250

      vi.restoreAllMocks();
    });

    it('should return floored integer', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);

      const result = backoffDelay(0, 100, 10000, 2);
      expect(Number.isInteger(result)).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('parseRetryAfter', () => {
    beforeEach(() => {
      // The `sleep` suite above enables fake timers without restoring them;
      // HTTP-date parsing depends on a real Date.now().
      vi.useRealTimers();
    });

    it('should return undefined for missing or unparseable values', () => {
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter('')).toBeUndefined();
      expect(parseRetryAfter('   ')).toBeUndefined();
      expect(parseRetryAfter('soon')).toBeUndefined();
      expect(parseRetryAfter('1.5')).toBeUndefined();
      expect(parseRetryAfter('-3')).toBeUndefined();
    });

    it('should parse integer seconds without maxMs', () => {
      expect(parseRetryAfter('0')).toBe(0);
      expect(parseRetryAfter('2')).toBe(2000);
      expect(parseRetryAfter(' 30 ')).toBe(30000);
    });

    it('should parse HTTP-date without maxMs', () => {
      const header = new Date(Date.now() + 5000).toUTCString();

      const result = parseRetryAfter(header);

      // toUTCString() truncates to whole seconds, so the parsed delay
      // lands in (4000, 5000] for a +5000ms target.
      expect(result).toBeGreaterThan(4000);
      expect(result!).toBeLessThanOrEqual(5000);
    });

    it('should return undefined for a past HTTP-date', () => {
      expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    });

    it('should cap parsed delay when maxMs is smaller', () => {
      expect(parseRetryAfter('30', 5000)).toBe(5000);
      expect(parseRetryAfter('120', 30000)).toBe(30000);
    });

    it('should leave parsed delay untouched when maxMs is larger', () => {
      expect(parseRetryAfter('2', 30000)).toBe(2000);
      expect(parseRetryAfter('0', 5000)).toBe(0);
    });

    it('should cap HTTP-date form with maxMs', () => {
      const header = new Date(Date.now() + 60000).toUTCString();

      expect(parseRetryAfter(header, 5000)).toBe(5000);
    });

    it('should leave HTTP-date delay untouched when under maxMs', () => {
      const header = new Date(Date.now() + 2000).toUTCString();

      const result = parseRetryAfter(header, 30000);

      expect(result).toBeGreaterThan(1000);
      expect(result!).toBeLessThanOrEqual(2000);
    });
  });

  describe('asNotRetryError', () => {
    it('should create an error with notRetryErrorSymbol', () => {
      const originalError = new Error('original');
      const wrappedError = asNotRetryError(originalError);

      expect(wrappedError.message).toBe('Not retryable error');
      expect(wrappedError.cause).toBe(originalError);
      expect((wrappedError as any)[notRetryErrorSymbol]).toBe(true);
    });

    it('should wrap non-Error values', () => {
      const wrappedError = asNotRetryError('string error');

      expect(wrappedError.cause).toBe('string error');
      expect((wrappedError as any)[notRetryErrorSymbol]).toBe(true);
    });
  });

  describe('isNotRetryError', () => {
    it('should return true for errors created with asNotRetryError', () => {
      const error = asNotRetryError(new Error('test'));
      expect(isNotRetryError(error)).toBe(true);
    });

    it('should return false for regular errors', () => {
      const error = new Error('test');
      expect(isNotRetryError(error)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isNotRetryError(null)).toBe(false);
      expect(isNotRetryError(undefined)).toBe(false);
    });

    it('should return false for non-error objects', () => {
      expect(isNotRetryError({})).toBe(false);
      expect(isNotRetryError({ [notRetryErrorSymbol]: false })).toBe(false);
    });
  });

  describe('getData', () => {
    it('should return data stored via setData', () => {
      const res = new Response('{}');
      setData(res, { parsed: true });
      expect(getData(res)).toEqual({ parsed: true });
    });

    it('should return undefined when no data was stored', () => {
      const res = new Response('{}');
      expect(getData(res)).toBeUndefined();
    });

    it('hasData should reflect setData', () => {
      const res = new Response('{}');
      expect(hasData(res)).toBe(false);
      setData(res, 'payload');
      expect(hasData(res)).toBe(true);
    });

    it('should keep the Response instance intact', () => {
      const res = new Response('{}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
      setData(res, { ok: true });
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(typeof res.json).toBe('function');
    });
  });

  describe('applyTimeout / applyTotalTimeout signal fallback', () => {
    // A fetch stand-in that behaves like native fetch for aborts: it
    // rejects with the abort reason of whatever signal it was handed.
    const fetchLike = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return resolve(new Response('ok'));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        })
    );

    const hidden: [string, PropertyDescriptor][] = [];

    const hideStatic = (key: 'timeout' | 'any') => {
      const desc = Object.getOwnPropertyDescriptor(AbortSignal, key);
      if (desc) hidden.push([key, desc]);
      // Reflect form: the no-dynamic-delete lint rule targets `delete obj[k]`
      // syntax; this is test-only surgery on a well-known static.
      Reflect.deleteProperty(AbortSignal, key);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      hideStatic('timeout');
      hideStatic('any');
    });

    afterEach(() => {
      for (const [key, desc] of hidden) {
        Object.defineProperty(AbortSignal, key, desc);
      }
      hidden.length = 0;
      vi.restoreAllMocks();
    });

    it('still times out through the manual fallback composition', async () => {
      const wrapped = applyTimeout(fetchLike, 100);
      const pending = wrapped('https://example.com/slow');
      vi.advanceTimersByTime(100);
      let caught: unknown;
      try {
        await pending;
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as Error).message).toBe('Request timed out after 100ms');
      // The reason mirrors native AbortSignal.timeout: a TimeoutError
      // DOMException, preserved as the library error's cause.
      expect((caught as TimeoutError).cause).toBeInstanceOf(DOMException);
      expect(((caught as TimeoutError).cause as Error).name).toBe('TimeoutError');
    });

    it('claims a cross-realm TimeoutError rejection by name, not instanceof', async () => {
      // Realm-mismatch regression (jsdom embedded in vitest): the fetch
      // rejection carries name 'TimeoutError' yet fails every instanceof
      // check of this module's realm. Discrimination must be name-based.
      const foreign = {name: 'TimeoutError', message: 'Signal timed out.'};
      const foreignFetch = vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) return reject(foreign);
            signal.addEventListener('abort', () => reject(foreign), {
              once: true,
            });
          })
      );
      const wrapped = applyTimeout(foreignFetch, 100);
      const pending = wrapped('https://example.com/slow');
      vi.advanceTimersByTime(100);
      const caught = await pending.catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).message).toBe(
        'Request timed out after 100ms'
      );
      expect((caught as TimeoutError).cause).toBe(foreign);
    });

    it('lets a user abort propagate unchanged through the manual composite', async () => {
      const wrapped = applyTimeout(fetchLike, 100);
      const controller = new AbortController();
      const pending = wrapped('https://example.com/x', {
        signal: controller.signal,
      });
      controller.abort();
      // The user's AbortError surfaces as-is — not a TimeoutError.
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects immediately when the user signal was already aborted', async () => {
      const wrapped = applyTimeout(fetchLike, 100);
      const controller = new AbortController();
      controller.abort();
      await expect(
        wrapped('https://example.com/x', { signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('applies the whole-request budget through the fallback', async () => {
      const wrapped = applyTotalTimeout(fetchLike, 100);
      const pending = wrapped('https://example.com/slow');
      vi.advanceTimersByTime(100);
      let caught: unknown;
      try {
        await pending;
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TimeoutError);
      expect(caught).not.toBeInstanceOf(DOMException);
      expect(((caught as TimeoutError).cause as Error).name).toBe('TimeoutError');
    });

    it('keeps a user abort on totalTimeout the caller-owned error', async () => {
      const wrapped = applyTotalTimeout(fetchLike, 100);
      const controller = new AbortController();
      const pending = wrapped('https://example.com/x', {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('resolves normally when the request finishes inside the budget', async () => {
      const immediate = vi.fn(async () => new Response('ok'));
      const wrapped = applyTimeout(immediate, 100);
      const res = await wrapped('https://example.com/fast');
      expect(res.status).toBe(200);
    });
  });

  describe('createQuery', () => {
    it('should create URLSearchParams from object', () => {
      const query = createQuery({ page: '1', limit: '10' });
      expect(query).toBeInstanceOf(URLSearchParams);
      expect(query.get('page')).toBe('1');
      expect(query.get('limit')).toBe('10');
    });

    it('should create URLSearchParams from tuple array', () => {
      const query = createQuery([
        ['tag', 'a'],
        ['tag', 'b'],
        ['page', '1'],
      ] as const);
      expect(query).toBeInstanceOf(URLSearchParams);
      expect(query.getAll('tag')).toEqual(['a', 'b']);
      expect(query.get('page')).toBe('1');
    });

    it('should create URLSearchParams from string', () => {
      const query = createQuery('page=1&limit=10');
      expect(query).toBeInstanceOf(URLSearchParams);
      expect(query.get('page')).toBe('1');
      expect(query.get('limit')).toBe('10');
    });

    it('should create URLSearchParams from existing URLSearchParams', () => {
      const existing = new URLSearchParams('page=1');
      const query = createQuery(existing);
      expect(query).toBeInstanceOf(URLSearchParams);
      expect(query.get('page')).toBe('1');
    });
  });
});
