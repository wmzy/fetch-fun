import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sleep,
  retry,
  backoffDelay,
  asNotRetryError,
  isNotRetryError,
} from '@/util';
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
});
