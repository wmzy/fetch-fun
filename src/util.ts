import { dataSymbol, notRetryErrorSymbol } from './constants';

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();

    let abortHandler: () => void;

    const timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      resolve();
    }, ms);

    if (signal) {
      abortHandler = () => {
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

export function getData<T = unknown>(res: Response): T {
  return (res as any)[dataSymbol] as T;
}

export type BeforeRetry = (attempt: number, error: unknown) => Promise<void>;

function retryBase<T>(
  task: () => Promise<T>,
  attempt: number,
  beforeRetry: BeforeRetry
): Promise<T> {
  return task().catch((e) => {
    return beforeRetry(attempt, e).then(() =>
      retryBase(task, attempt + 1, beforeRetry)
    );
  });
}

export function retry<T>(
  task: () => Promise<T>,
  beforeRetry: BeforeRetry
): Promise<T> {
  return retryBase(task, 0, beforeRetry);
}

export function backoffDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);

  // Add jitter (±25% random variation)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.floor(cappedDelay + jitter);
}

export function asNotRetryError(e: unknown): Error {
  const err = new Error('Not retryable error');
  (err as any).cause = e;
  (err as any)[notRetryErrorSymbol] = true;
  return err;
}

export function isNotRetryError(e: unknown): e is Error {
  return ((e as any) || {})[notRetryErrorSymbol] === true;
}
