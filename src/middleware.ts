import type { Fetchable, Middleware } from './types';
import { sleep, retry, backoffDelay, isNotRetryError } from './util';

export type FetchBeforeRetry = (
  attempt: number,
  error: unknown,
  o: Fetchable
) => Promise<void>;

export function createRetryBase(beforeRetry: FetchBeforeRetry): Middleware {
  return (f, o) =>
    (...params: Parameters<typeof f>) =>
      retry(
        () => f(...params),
        (attempt, err) => beforeRetry(attempt, err, o)
      );
}

export function createRetry(maxRetries: number): Middleware {
  return createRetryBase(async (attempt, error, o) => {
    if (isNotRetryError(error)) throw error.cause;
    if (attempt >= maxRetries) throw error;

    await sleep(backoffDelay(attempt, 1000, 10000, 2), o.signal);
  });
}
