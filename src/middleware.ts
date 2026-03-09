import type {
  Fetchable,
  MiddlewareFn,
  MiddlewareConfig,
  MiddlewareEntry,
  MiddlewareInput,
  MiddlewareName,
} from './types';
import { NORMAL } from './types';
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
export function createRetryBase(beforeRetry: FetchBeforeRetry): MiddlewareFn {
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
export function createRetry(maxRetries: number): MiddlewareFn {
  return createRetryBase(async (attempt, error, o) => {
    if (isNotRetryError(error)) throw error.cause;
    if (attempt >= maxRetries) throw error;

    await sleep(backoffDelay(attempt, 1000, 10000, 2), o.signal);
  });
}

// ============================================================================
// Middleware Ordering System
// ============================================================================

let middlewareIdCounter = 0;

/**
 * Normalizes a middleware input to a MiddlewareEntry.
 *
 * @param input - A middleware function or configuration object
 * @returns A normalized MiddlewareEntry with name and positioning
 */
export function normalizeMiddleware(input: MiddlewareInput): MiddlewareEntry {
  if (typeof input === 'function') {
    return {
      name: Symbol(
        `middleware-${++middlewareIdCounter}`
      ) as unknown as MiddlewareName,
      middleware: input,
    };
  }
  return {
    name:
      input.name ??
      (Symbol(
        `middleware-${++middlewareIdCounter}`
      ) as unknown as MiddlewareName),
    outer: input.outer,
    inner: input.inner,
    middleware: input.middleware,
  };
}

/**
 * Sorts middlewares based on their positioning constraints.
 *
 * In the onion model:
 * - Outer middlewares wrap inner middlewares
 * - `outer: X` means this middleware should be outside (wrap) X
 * - `inner: X` means this middleware should be inside (wrapped by) X
 *
 * The sorting ensures that:
 * 1. Middlewares with `outer: NORMAL` come first (outermost)
 * 2. NORMAL middlewares come in the middle
 * 3. Middlewares with `inner: NORMAL` come after NORMAL
 * 4. Named middlewares are positioned relative to each other
 *
 * @param entries - Array of middleware entries to sort
 * @returns Sorted array of middleware entries (outer to inner)
 */
export function sortMiddlewares(entries: MiddlewareEntry[]): MiddlewareEntry[] {
  if (entries.length <= 1) return entries;

  // Build a map of name -> entry for quick lookup
  const nameToEntry = new Map<MiddlewareName, MiddlewareEntry>();
  for (const entry of entries) {
    nameToEntry.set(entry.name, entry);
  }

  // Build dependency graph: edges[a] = [b] means a should come before b
  const edges = new Map<MiddlewareName, Set<MiddlewareName>>();
  const getEdges = (name: MiddlewareName) => {
    if (!edges.has(name)) edges.set(name, new Set());
    return edges.get(name)!;
  };

  // Process positioning constraints
  for (const entry of entries) {
    // If this middleware should be outer (wrap) target, it comes before target
    if (entry.outer !== undefined) {
      getEdges(entry.name).add(entry.outer);
    }
    // If this middleware should be inner (wrapped by) target, target comes before this
    if (entry.inner !== undefined) {
      getEdges(entry.inner).add(entry.name);
    }
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<MiddlewareName, number>();
  for (const entry of entries) {
    inDegree.set(entry.name, 0);
  }

  for (const [, targets] of edges) {
    for (const target of targets) {
      if (inDegree.has(target)) {
        inDegree.set(target, inDegree.get(target)! + 1);
      }
    }
  }

  // Start with nodes that have no incoming edges
  const queue: MiddlewareName[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: MiddlewareEntry[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const entry = nameToEntry.get(name);
    if (entry) {
      sorted.push(entry);
    }

    const targets = edges.get(name);
    if (targets) {
      for (const target of targets) {
        if (inDegree.has(target)) {
          const newDegree = inDegree.get(target)! - 1;
          inDegree.set(target, newDegree);
          if (newDegree === 0) {
            queue.push(target);
          }
        }
      }
    }
  }

  // If there's a cycle, return original order (or throw error)
  if (sorted.length !== entries.length) {
    console.warn('Middleware dependency cycle detected, using original order');
    return entries;
  }

  return sorted;
}

// ============================================================================
// Built-in Middleware Factories
// ============================================================================

/**
 * Creates a retry middleware configuration with exponential backoff.
 *
 * Name: 'builtin:retry'
 *
 * @param maxRetries - Maximum number of retry attempts
 * @returns A middleware configuration with proper naming
 *
 * @example
 * ```ts
 * client.pipe(use, withRetry(3))
 * ```
 */
export function withRetry(maxRetries: number) {
  return {
    name: 'builtin:retry' as const,
    middleware: createRetry(maxRetries),
  };
}

/**
 * Creates a timeout middleware configuration using AbortSignal.
 *
 * Name: 'builtin:timeout'
 * Position: outer of 'builtin:retry' (timeout wraps retry)
 *
 * @param ms - Timeout in milliseconds
 * @returns A middleware configuration with proper naming and positioning
 *
 * @example
 * ```ts
 * client.pipe(use, withTimeout(5000))
 * ```
 */
export function withTimeout(ms: number) {
  return {
    name: 'builtin:timeout' as const,
    outer: 'builtin:retry' as const,
    middleware: ((f) => (input, init) =>
      f(input, { ...init, signal: AbortSignal.timeout(ms) })) as MiddlewareFn,
  };
}

/**
 * Creates a Bearer token authentication middleware configuration.
 *
 * Name: 'builtin:auth'
 * Position: inner of 'builtin:retry' (auth is applied on each retry)
 *
 * @param token - The Bearer token
 * @returns A middleware configuration with proper naming and positioning
 *
 * @example
 * ```ts
 * client.pipe(use, withAuth('your-jwt-token'))
 * ```
 */
export function withAuth(token: string) {
  return {
    name: 'builtin:auth' as const,
    inner: 'builtin:retry' as const,
    middleware: ((f) => (input, init) =>
      f(input, {
        ...init,
        headers: {
          ...((init?.headers as Record<string, string>) || {}),
          Authorization: `Bearer ${token}`,
        },
      })) as MiddlewareFn,
  };
}

/**
 * Creates a request/response logging middleware configuration.
 *
 * Name: 'builtin:logging'
 * Position: outer of NORMAL (logging wraps all normal middlewares)
 *
 * @param logger - Custom logger function (defaults to console.log)
 * @returns A middleware configuration with proper naming and positioning
 *
 * @example
 * ```ts
 * // With default console.log
 * client.pipe(use, withLogging())
 *
 * // With custom logger
 * client.pipe(use, withLogging((msg, data) => myLogger.info(msg, data)))
 * ```
 */
export function withLogging(
  logger: (msg: string, data?: unknown) => void = console.log
) {
  return {
    name: 'builtin:logging' as const,
    outer: NORMAL,
    middleware: ((f, o) =>
      async (...params) => {
        logger('Request:', { url: o.url, method: o.method });
        const start = Date.now();
        try {
          const res = await f(...params);
          logger('Response:', {
            url: o.url,
            status: res.status,
            duration: Date.now() - start,
          });
          return res;
        } catch (error) {
          logger('Error:', { url: o.url, error, duration: Date.now() - start });
          throw error;
        }
      }) as MiddlewareFn,
  };
}
