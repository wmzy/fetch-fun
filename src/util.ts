import { dataSymbol, notRetryErrorSymbol } from './constants';

/**
 * Returns a Promise that resolves after the specified delay.
 *
 * Supports early cancellation via AbortSignal. If the signal is already
 * aborted when called, resolves immediately.
 *
 * @param ms - The delay in milliseconds
 * @param signal - Optional AbortSignal for early cancellation
 * @returns A Promise that resolves after the delay or when aborted
 *
 * @example
 * ```ts
 * // Simple delay
 * await sleep(1000);
 *
 * // With cancellation support
 * const controller = new AbortController();
 * await sleep(5000, controller.signal);
 * // Call controller.abort() to cancel early
 * ```
 */
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

/**
 * Extracts parsed data from a Response object.
 *
 * Use this to retrieve data that was parsed by `data`, `json`, `text`, or `blob` middleware.
 *
 * @template T - The expected data type
 * @param res - The Response object containing parsed data
 * @returns The parsed data
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/users').pipe(json).pipe(fetch);
 * const users = getData<User[]>(response);
 * ```
 */
export function getData<T = unknown>(res: Response): T {
  return (res as any)[dataSymbol] as T;
}

/**
 * Callback function invoked before each retry attempt.
 *
 * @param attempt - The current attempt number (0-indexed)
 * @param error - The error that caused the retry
 * @returns A Promise that resolves when ready to retry, or rejects to stop retrying
 */
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

/**
 * Retries an async task until it succeeds or beforeRetry throws.
 *
 * The beforeRetry callback controls retry behavior:
 * - Resolve to continue retrying
 * - Reject/throw to stop retrying
 *
 * @template T - The return type of the task
 * @param task - The async task to retry
 * @param beforeRetry - Callback invoked before each retry
 * @returns A Promise resolving to the task result
 *
 * @example
 * ```ts
 * const result = await retry(
 *   () => fetchData(),
 *   async (attempt, error) => {
 *     if (attempt >= 3) throw error;
 *     await sleep(1000 * attempt);
 *   }
 * );
 * ```
 */
export function retry<T>(
  task: () => Promise<T>,
  beforeRetry: BeforeRetry
): Promise<T> {
  return retryBase(task, 0, beforeRetry);
}

/**
 * Calculates delay for exponential backoff with jitter.
 *
 * The delay follows the formula: `initialDelay * (multiplier ^ attempt)`
 * capped at `maxDelay`, with ±25% random jitter.
 *
 * @param attempt - The current attempt number (0-indexed)
 * @param initialDelay - The base delay in milliseconds
 * @param maxDelay - The maximum delay cap in milliseconds
 * @param multiplier - The exponential multiplier
 * @returns The calculated delay in milliseconds
 *
 * @example
 * ```ts
 * // With initialDelay=1000, maxDelay=10000, multiplier=2:
 * backoffDelay(0, 1000, 10000, 2); // ~1000ms (±25%)
 * backoffDelay(1, 1000, 10000, 2); // ~2000ms (±25%)
 * backoffDelay(2, 1000, 10000, 2); // ~4000ms (±25%)
 * backoffDelay(5, 1000, 10000, 2); // ~10000ms (capped, ±25%)
 * ```
 */
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

/**
 * Wraps an error to mark it as non-retryable.
 *
 * Use this to prevent retry middleware from retrying certain errors,
 * such as authentication failures or validation errors.
 *
 * @param e - The original error to wrap
 * @returns A new Error marked as non-retryable, with original error as cause
 *
 * @example
 * ```ts
 * // In error handling middleware
 * client.pipe(checkError, (res) => {
 *   if (res.status === 401) {
 *     throw asNotRetryError(new Error('Unauthorized'));
 *   }
 * })
 * ```
 */
export function asNotRetryError(e: unknown): Error {
  const err = new Error('Not retryable error');
  (err as any).cause = e;
  (err as any)[notRetryErrorSymbol] = true;
  return err;
}

/**
 * Checks if an error is marked as non-retryable.
 *
 * @param e - The error to check
 * @returns True if the error was wrapped with `asNotRetryError`
 *
 * @example
 * ```ts
 * try {
 *   await fetchData();
 * } catch (e) {
 *   if (isNotRetryError(e)) {
 *     // Handle non-retryable error
 *     console.error('Cannot retry:', e.cause);
 *   }
 * }
 * ```
 */
export function isNotRetryError(e: unknown): e is Error {
  return ((e as any) || {})[notRetryErrorSymbol] === true;
}

// ============ Query Type Utilities ============

/**
 * Extract all unique keys from a tuple array.
 * [['a', 'b'], ['a', 'c'], ['d', 'e']] => 'a' | 'd'
 */
type ExtractKeys<T extends readonly (readonly [string, string])[]> =
  T[number][0];

/**
 * Collect all values for a specific key from a tuple array.
 * CollectValues<[['a', 'b'], ['a', 'c'], ['d', 'e']], 'a'> => ['b', 'c']
 */
type CollectValues<
  T extends readonly (readonly [string, string])[],
  K extends string,
  Acc extends string[] = []
> = T extends readonly [
  readonly [infer Key, infer Value],
  ...infer Rest extends readonly (readonly [string, string])[]
]
  ? Key extends K
    ? Value extends string
      ? CollectValues<Rest, K, [...Acc, Value]>
      : CollectValues<Rest, K, Acc>
    : CollectValues<Rest, K, Acc>
  : Acc;

/**
 * Convert collected values to final type.
 * Single value stays as string, multiple values become tuple.
 * ['b'] => 'b'
 * ['b', 'c'] => ['b', 'c']
 */
type ValuesToType<V extends string[]> = V extends [infer Single extends string]
  ? Single
  : V;

/**
 * Convert tuple array to record with proper handling of duplicate keys.
 * [['a', 'b'], ['a', 'c'], ['d', 'e']] as const => { a: ['b', 'c'], d: 'e' }
 */
export type TupleArrayToRecord<
  T extends readonly (readonly [string, string])[]
> = {
  [K in ExtractKeys<T>]: ValuesToType<CollectValues<T, K>>;
};

// ============ Typed URLSearchParams ============

import type { TypedURLSearchParams } from './types';

/**
 * Forces TypeScript to expand/simplify a type for better IDE display.
 * Converts complex nested types into their flattened form.
 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Creates a URLSearchParams with type information for IDE hints.
 *
 * Accepts various input formats:
 * - Object: `{ page: '1', limit: '10' }`
 * - Tuple array: `[['tag', 'a'], ['tag', 'b']]` (supports duplicate keys)
 * - String: `'page=1&limit=10'`
 * - URLSearchParams: existing instance
 * - TypedURLSearchParams: preserves type information
 *
 * @template T - The input type (object or tuple array)
 * @param input - The query parameters input
 * @returns A URLSearchParams with type information
 *
 * @example
 * ```ts
 * // With object - type is { page: '1', limit: '10' }
 * const q1 = createQuery({ page: '1', limit: '10' } as const);
 *
 * // With tuple array - type is { tag: ['a', 'b'], page: '1' }
 * const q2 = createQuery([['tag', 'a'], ['tag', 'b'], ['page', '1']] as const);
 *
 * // Type information is preserved for IDE hints
 * q1._type; // { page: '1', limit: '10' }
 * q2._type; // { tag: ['a', 'b'], page: '1' }
 * ```
 */
// Overload 1: Object input
export function createQuery<const T extends Record<string, string>>(
  input: T
): TypedURLSearchParams<Prettify<T>>;
// Overload 2: Tuple array input
export function createQuery<
  const T extends readonly (readonly [string, string])[]
>(input: T): TypedURLSearchParams<Prettify<TupleArrayToRecord<T>>>;
// Overload 3: TypedURLSearchParams input (preserve type)
export function createQuery<Q extends Record<string, string | string[]>>(
  input: TypedURLSearchParams<Q>
): TypedURLSearchParams<Prettify<Q>>;
// Overload 4: Plain string or URLSearchParams
export function createQuery(
  input: string | URLSearchParams
): TypedURLSearchParams<Record<string, string>>;
// Implementation
export function createQuery(
  input:
    | Record<string, string>
    | readonly (readonly [string, string])[]
    | string
    | URLSearchParams
): TypedURLSearchParams<Record<string, string | string[]>> {
  return new URLSearchParams(
    input as ConstructorParameters<typeof URLSearchParams>[0]
  ) as TypedURLSearchParams<Record<string, string | string[]>>;
}
