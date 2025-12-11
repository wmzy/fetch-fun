import type { Fetchable, Middleware } from './types';
import { sleep, retry, backoffDelay, isNotRetryError } from './util';

/**
 * Callback function invoked before each retry attempt.
 *
 * @param attempt - The current attempt number (0-indexed)
 * @param error - The error that caused the retry
 * @param o - The fetchable configuration
 * @returns A Promise that resolves when ready to retry, or rejects to stop retrying
 */
export type FetchBeforeRetry = (
  attempt: number,
  error: unknown,
  o: Fetchable
) => Promise<void>;

/**
 * Creates a retry middleware with custom retry logic.
 *
 * This is the base function for creating retry middlewares with custom behavior.
 * Use `createRetry` for a simpler API with built-in exponential backoff.
 *
 * @param beforeRetry - Callback invoked before each retry attempt
 * @returns A middleware function that adds retry capability
 *
 * @example
 * ```ts
 * // Custom retry with logging
 * const retryWithLogging = createRetryBase(async (attempt, error, o) => {
 *   console.log(`Retry attempt ${attempt} for ${o.url}`);
 *   if (attempt >= 3) throw error;
 *   await sleep(1000 * attempt);
 * });
 *
 * client.pipe(use, retryWithLogging)
 * ```
 */
export function createRetryBase(beforeRetry: FetchBeforeRetry): Middleware {
  return (f, o) =>
    (...params: Parameters<typeof f>) =>
      retry(
        () => f(...params),
        (attempt, err) => beforeRetry(attempt, err, o)
      );
}

/**
 * Creates a retry middleware with exponential backoff.
 *
 * Automatically retries failed requests with exponential backoff and jitter.
 * - Initial delay: 1000ms
 * - Maximum delay: 10000ms
 * - Multiplier: 2x per attempt
 * - Jitter: ±25% random variation
 *
 * Errors wrapped with `asNotRetryError()` will not be retried.
 *
 * @param maxRetries - Maximum number of retry attempts
 * @returns A middleware function that adds retry capability
 *
 * @example
 * ```ts
 * // Retry up to 3 times
 * client.pipe(use, createRetry(3))
 *
 * // Or use the convenience function
 * client.pipe(retry, 3)
 * ```
 */
export function createRetry(maxRetries: number): Middleware {
  return createRetryBase(async (attempt, error, o) => {
    if (isNotRetryError(error)) throw error.cause;
    if (attempt >= maxRetries) throw error;

    await sleep(backoffDelay(attempt, 1000, 10000, 2), o.signal);
  });
}
