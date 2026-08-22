import type { TypedURLSearchParams } from './types';

import { notRetryErrorSymbol } from './constants';
import { TimeoutError } from './errors';

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
 * Wraps a fetch function with a per-call timeout signal.
 *
 * Each invocation creates a fresh `AbortSignal.timeout(ms)` — so every call,
 * including every retry attempt by an outer middleware, gets its own time
 * budget — and combines it with any signal already present in `init` using
 * `AbortSignal.any` (requires Node.js >= 20.3.0 or a modern browser).
 *
 * A timeout abort surfaces as a {@link TimeoutError} with the underlying
 * `DOMException` attached as `cause`; user-initiated aborts (`AbortError`)
 * propagate unchanged.
 *
 * @param f - The fetch function to wrap
 * @param ms - The timeout budget in milliseconds
 * @returns A fetch function that aborts after `ms` per call
 */
export function applyTimeout(
  f: typeof globalThis.fetch,
  ms: number
): typeof globalThis.fetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(ms);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await f(input, { ...init, signal });
    } catch (e) {
      if (
        timeoutSignal.aborted &&
        e instanceof DOMException &&
        e.name === 'TimeoutError'
      ) {
        throw new TimeoutError(`Request timed out after ${ms}ms`, {
          cause: e,
        });
      }
      throw e;
    }
  };
}

/**
 * Wraps a fetch function with a whole-request timeout signal.
 *
 * Unlike {@link applyTimeout}, which grants every call a fresh budget, the
 * budget here spans the entire wrapped function — every retry attempt made
 * by an inner middleware plus the backoff delays between them. Each
 * invocation creates one `AbortSignal.timeout(ms)` and combines it with any
 * signal already present in `init` using `AbortSignal.any` (requires
 * Node.js >= 20.3.0 or a modern browser), so wrapping `applyTimeout`
 * (nested `AbortSignal.any` compositions) composes cleanly.
 *
 * A timeout abort surfaces as a {@link TimeoutError} with the underlying
 * `DOMException` attached as `cause`; user-initiated aborts
 * (`AbortError`, including a user `signal` that fired in the same race)
 * propagate unchanged.
 *
 * @param f - The fetch function to wrap (e.g. a fully applied middleware chain)
 * @param ms - The whole-request timeout budget in milliseconds
 * @returns A fetch function that aborts after `ms` in total per request
 */
export function applyTotalTimeout(
  f: typeof globalThis.fetch,
  ms: number
): typeof globalThis.fetch {
  return async (input, init) => {
    const userSignal = init?.signal;
    const totalSignal = AbortSignal.timeout(ms);
    const signal = userSignal
      ? AbortSignal.any([userSignal, totalSignal])
      : totalSignal;
    try {
      return await f(input, { ...init, signal });
    } catch (e) {
      // Only claim the error when our own budget elapsed and the user's
      // signal is still intact — otherwise the abort belongs to the caller.
      if (
        totalSignal.aborted &&
        !userSignal?.aborted &&
        e instanceof DOMException &&
        (e.name === 'TimeoutError' || e.name === 'AbortError')
      ) {
        throw new TimeoutError(`Request timed out after ${ms}ms`, {
          cause: e,
        });
      }
      throw e;
    }
  };
}

/**
 * Module-level store for parsed response data.
 *
 * Uses a WeakMap keyed by the original Response so the response's prototype
 * (status, headers, body, etc.) stays fully intact.
 */
const dataStore = new WeakMap<Response, unknown>();

/**
 * Checks whether parsed data has been stored for a response.
 *
 * @param res - The response to inspect
 * @returns True if data was previously stored via `setData`
 */
export function hasData(res: Response): boolean {
  return dataStore.has(res);
}

/**
 * Stores parsed data for a response without altering the response object.
 *
 * @param res - The response to attach data to
 * @param data - The parsed data to store
 */
export function setData(res: Response, data: unknown): void {
  dataStore.set(res, data);
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
  return dataStore.get(res) as T;
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
 * Parses a `Retry-After` response header value into a delay in milliseconds.
 *
 * Accepts both formats allowed by RFC 9110:
 * - Integer seconds: `'3'` → `3000`
 * - HTTP-date: `'Wed, 21 Oct 2015 07:28:00 GMT'` → milliseconds from now
 *   until that instant
 *
 * Returns `undefined` when the value is missing, empty, matches neither
 * format, or is an HTTP-date in the past (a non-positive wait is
 * meaningless — the caller should fall back to its backoff strategy).
 *
 * An optional `maxMs` caps the wait: a parsed delay larger than `maxMs` is
 * clamped down to it — the caller still waits (and retries), just no longer
 * than allowed — rather than skipping the retry entirely. Omitting `maxMs`
 * leaves the parsed value untouched.
 *
 * @param header - The raw header value, or `null` when the header is absent
 * @param maxMs - Optional upper bound for the returned delay in milliseconds;
 *   larger parsed values are capped to it
 * @returns The delay in milliseconds (capped at `maxMs` when provided), or
 *   `undefined` when unparseable
 *
 * @example
 * ```ts
 * parseRetryAfter('2');                                  // 2000
 * parseRetryAfter(new Date(Date.now() + 5000).toUTCString()); // ~5000
 * parseRetryAfter('soon');                                // undefined
 * parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT');       // undefined (past)
 *
 * // Capping a hostile server's 2-minute demand at 30 seconds
 * parseRetryAfter('120', 30000);                          // 30000
 * parseRetryAfter('2', 30000);                            // 2000 (under cap)
 * parseRetryAfter(new Date(Date.now() + 60000).toUTCString(), 5000); // 5000
 * ```
 */
export function parseRetryAfter(
  header: string | null,
  maxMs?: number
): number | undefined {
  if (header == null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;

  let ms: number;

  // Integer-seconds form. Values outside the `\d+` grammar (fractional,
  // negative, units, ...) fall through to the date parse, which rejects
  // them cleanly.
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    // HTTP-date form
    const until = Date.parse(value);
    if (Number.isNaN(until)) return undefined;
    ms = until - Date.now();
  }

  if (ms < 0) return undefined; // HTTP-date in the past
  return maxMs == null ? ms : Math.min(ms, maxMs);
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
