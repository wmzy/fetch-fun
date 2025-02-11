import { Middleware } from './types';
import { sleep } from './util';

export function createRetryBase(
  beforeRetry: (o: { retryCount: number; lastError: Error }) => Promise<void>
): Middleware {
  return (f) =>
    (...params) => {
      let retryCount = 0;
      function task(): ReturnType<typeof f> {
        return f(...params).catch((e) =>
          beforeRetry({
            retryCount: retryCount++,
            lastError: e,
          }).then(task)
        );
      }
      return task();
    };
}

export function createRetry(maxRetries: number): Middleware {
  return createRetryBase(({ retryCount, lastError }) =>
    retryCount < maxRetries
      ? sleep(1000 * Math.pow(2, retryCount))
      : Promise.reject(lastError)
  );
}
