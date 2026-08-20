import type {
  Fetchable,
  MiddlewareFn,
  MiddlewareConfig,
  MiddlewareEntry,
  MiddlewareInput,
  MiddlewareName,
} from './types';
import { NORMAL } from './types';
import { sleep, retry, backoffDelay, isNotRetryError, applyTimeout, parseRetryAfter } from './util';
import { HTTPError, ValidationError } from './errors';

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
 * Configuration for the retry policy of {@link createRetry}.
 */
export type RetryOptions = {
  /**
   * Response statuses worth retrying. Other statuses resolve normally
   * (and surface as `HTTPError` from `fetchData`).
   * @default [408, 425, 429, 500, 502, 503, 504]
   */
  statuses?: readonly number[];
  /**
   * HTTP methods worth retrying. Requests whose method is not listed are
   * never retried (even on retryable statuses or network errors) to avoid
   * duplicating side effects of non-idempotent operations.
   * Compared case-insensitively.
   * @default ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']
   */
  methods?: readonly string[];
  /**
   * When true and the discarded response carries a parseable, non-past
   * `Retry-After` header (integer seconds or HTTP-date), that delay takes
   * priority over exponential backoff.
   * @default true
   */
  respectRetryAfter?: boolean;
  /**
   * Upper bound (in milliseconds) for delays honored from a `Retry-After`
   * header. A server demanding a longer pause is clamped down to this
   * value — the retry still happens, just sooner than requested. Only
   * relevant when `respectRetryAfter` is true.
   * @default 30000
   */
  maxRetryAfter?: number;
  /**
   * Custom retry predicate that fully replaces the built-in decision of
   * *which* attempts are worth retrying (status-set membership for
   * resolved responses, error classification for rejections). Receives the
   * 0-indexed attempt number and either the resolved `response` or the
   * thrown `error`; return `true` (or a promise of it) to retry, `false`
   * to surface the response/error as-is.
   *
   * Hard rules still apply regardless of the predicate's answer:
   * `asNotRetryError`-wrapped and `ValidationError` rejections are
   * rethrown, requests whose method is not retryable never retry, and
   * attempts stop once `maxRetries` is reached.
   */
  shouldRetry?: (
    attempt: number,
    result: { response?: Response; error?: unknown }
  ) => boolean | Promise<boolean>;
  /**
   * Exponential backoff tuning (passed to `backoffDelay`).
   * @default { initial: 1000, max: 10000, multiplier: 2 }
   */
  delay?: {
    initial?: number;
    max?: number;
    multiplier?: number;
  };
}

/**
 * Default statuses considered transient enough to retry.
 */
const DEFAULT_RETRY_STATUSES: readonly number[] = [
  408, 425, 429, 500, 502, 503, 504,
];

/**
 * Default methods considered safe (idempotent) to retry.
 */
const DEFAULT_RETRY_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'PUT',
  'DELETE',
];

/**
 * Creates a retry middleware with a status/method/error-aware policy.
 *
 * **Behavior change from the previous unconditional retry:** only requests
 * whose method is (by default) idempotent are retried, and only for
 * transient-looking failures:
 *
 * - Rejected attempts: network failures (surfaced as `NetworkError` by the
 *   built-in innermost wrapper, with the original `TypeError` preserved as
 *   `cause`), library `TimeoutError`, and unknown errors are retried;
 *   `HTTPError` (thrown by
 *   a user `checkError` middleware) is retried only when its status is in
 *   `statuses`; `ValidationError` and errors wrapped with
 *   `asNotRetryError()` are never retried (rethrowing the wrapped `cause`).
 * - Resolved attempts: retried only when `response.status` is in
 *   `statuses` — a 404 resolves as-is instead of burning retries (and is
 *   turned into an `HTTPError` by `fetchData` outside the middleware chain).
 *
 * When `opts.shouldRetry` is provided it **replaces** both of those
 * status/error decisions: the predicate receives the 0-indexed attempt
 * number plus either the resolved `response` or the thrown `error`, and
 * its (possibly async) answer decides whether to retry. Hard rules always
 * win over the predicate: `asNotRetryError`-wrapped and `ValidationError`
 * rejections are rethrown, requests whose method is not in `methods`
 * never retry, and attempts stop once `maxRetries` is reached.
 *
 * Waits between attempts use exponential backoff with jitter
 * (`delay.initial` → `delay.max`, ×`delay.multiplier` per attempt), unless
 * the discarded response provides a parseable, non-past `Retry-After`
 * header and `respectRetryAfter` is true — then that value wins, capped
 * at `maxRetryAfter` (default 30s). The discarded response's body is
 * cancelled before retrying to avoid leaks. Waits are interrupted by the
 * client's `signal` (see `sleep`).
 *
 * @param maxRetries - Maximum number of retry attempts (the initial attempt
 * is not counted)
 * @param opts - Policy overrides (statuses, methods, Retry-After handling,
 * backoff tuning)
 * @returns A middleware function that adds retry capability
 *
 * @example
 * ```ts
 * // Retry idempotent requests up to 3 times on 5xx/429/network errors
 * client.pipe(retry, 3)
 *
 * // Custom policy: also retry POSTs, only on 503, wait 5s between tries
 * client.pipe(retry, 3, {
 *   methods: ['GET', 'POST'],
 *   statuses: [503],
 *   delay: { initial: 5000, max: 30000 },
 * })
 * ```
 */
export function createRetry(
  maxRetries: number,
  opts?: RetryOptions
): MiddlewareFn {
  const statuses = new Set(opts?.statuses ?? DEFAULT_RETRY_STATUSES);
  const methods = new Set(
    (opts?.methods ?? DEFAULT_RETRY_METHODS).map((m) => m.toUpperCase())
  );
  const respectRetryAfter = opts?.respectRetryAfter ?? true;
  const maxRetryAfter = opts?.maxRetryAfter ?? 30000;
  const shouldRetry = opts?.shouldRetry;
  const { initial = 1000, max = 10000, multiplier = 2 } = opts?.delay ?? {};

  return (f, o) =>
    async (input, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      const canRetryMethod = methods.has(method);

      let attempt = 0;
      for (;;) {
        let res: Response;
        try {
          res = await f(input, init);
        } catch (e) {
          // Explicit opt-out: unwrap and rethrow the original error.
          if (isNotRetryError(e)) throw e.cause ?? e;
          // A schema validation failure is deterministic — retrying
          // cannot fix it.
          if (e instanceof ValidationError) throw e;
          // Hard gates: a non-retryable method or an exhausted budget is
          // never overridden, not even by a custom shouldRetry predicate.
          if (!canRetryMethod || attempt >= maxRetries) throw e;
          if (shouldRetry) {
            // Custom predicate replaces the error classification below.
            if (!(await shouldRetry(attempt, { error: e }))) throw e;
          } else if (
            e instanceof HTTPError &&
            !statuses.has(e.response.status)
          ) {
            // HTTPError from a user checkError middleware: retry only when
            // its status is in the retryable set. Everything else (network
            // `NetworkError`, library TimeoutError, unknown errors) is
            // treated as transient.
            throw e;
          }

          // No response to consult for Retry-After on the rejection path.
          await sleep(
            backoffDelay(attempt, initial, max, multiplier),
            o.signal
          );
          attempt += 1;
          continue;
        }

        // Resolved attempt: retry transient statuses on retryable methods;
        // return everything else as-is (4xx stays a Response here —
        // fetchData raises HTTPError outside the middleware chain).
        if (canRetryMethod && attempt < maxRetries) {
          // A custom predicate replaces the status-set decision, but only
          // after the method/count hard gates above have passed.
          const worthRetrying = shouldRetry
            ? await shouldRetry(attempt, { response: res })
            : statuses.has(res.status);
          if (worthRetrying) {
            const retryAfterMs = respectRetryAfter
              ? parseRetryAfter(res.headers.get('Retry-After'), maxRetryAfter)
              : undefined;
            // Release the discarded response's body to avoid leaking it.
            res.body?.cancel().catch(() => undefined);
            await sleep(
              retryAfterMs ?? backoffDelay(attempt, initial, max, multiplier),
              o.signal
            );
            attempt += 1;
            continue;
          }
        }
        return res;
      }
    };
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
 * NORMAL acts as a virtual node anchoring the default position, so the
 * groups above hold even when nothing is named NORMAL. Positioning edges
 * that reference an unregistered middleware name (other than NORMAL) are
 * ignored — they cannot be satisfied and never create a cycle.
 *
 * @param entries - Array of middleware entries to sort
 * @returns Sorted array of middleware entries (outer to inner)
 * @throws {Error} If two entries share the same name, or if positioning
 * constraints form a cycle (the error message names the middleware cycle)
 */
export function sortMiddlewares(entries: MiddlewareEntry[]): MiddlewareEntry[] {
  if (entries.length <= 1) return entries;

  // Build a map of name -> entry for quick lookup, rejecting duplicate names:
  // duplicates would silently overwrite each other and make positioning
  // constraints ambiguous.
  const nameToEntry = new Map<MiddlewareName, MiddlewareEntry>();
  for (const entry of entries) {
    if (nameToEntry.has(entry.name)) {
      throw new Error(
        `Duplicate middleware name "${String(entry.name)}". ` +
          'Middleware names must be unique; use pipe(retry, n) / pipe(use, <middleware fn>) ' +
          '(which generate unique anonymous names) or provide a custom unique name.'
      );
    }
    nameToEntry.set(entry.name, entry);
  }

  // Build dependency graph: edges a -> b means a should come before b.
  //
  // NORMAL participates as a virtual node: it has no entry behind it, starts
  // with in-degree 0, and anchors the default position — so `outer: NORMAL`
  // middlewares sort before the NORMAL group and `inner: NORMAL` middlewares
  // after it, even when nothing is literally named NORMAL. Edges targeting
  // any other unregistered name are dangling constraints and are ignored:
  // they order nothing in this chain and must never invent a fake cycle.
  const edges = new Map<MiddlewareName, Set<MiddlewareName>>();
  const addEdge = (from: MiddlewareName, to: MiddlewareName) => {
    if (from === to) return; // a self-edge is always a bogus constraint
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };

  // Process positioning constraints; only edges with a resolvable target
  // (a registered name or NORMAL) participate in the graph.
  for (const entry of entries) {
    // If this middleware should be outer (wrap) target, it comes before target
    if (
      entry.outer !== undefined &&
      (entry.outer === NORMAL || nameToEntry.has(entry.outer))
    ) {
      addEdge(entry.name, entry.outer);
    }
    // If this middleware should be inner (wrapped by) target, target comes before this
    if (
      entry.inner !== undefined &&
      (entry.inner === NORMAL || nameToEntry.has(entry.inner))
    ) {
      addEdge(entry.inner, entry.name);
    }
  }

  // Anchor middlewares without explicit positioning into the NORMAL group:
  // after every `outer: NORMAL` middleware (those precede NORMAL itself) and
  // before every `inner: NORMAL` middleware, preserving pipe order within
  // the group. This holds no matter the order they were added in.
  const anonymous = entries.filter(
    (e) => e.outer === undefined && e.inner === undefined
  );
  for (const a of anonymous) {
    addEdge(NORMAL, a.name);
  }
  for (const a of anonymous) {
    for (const entry of entries) {
      if (entry.inner === NORMAL) addEdge(a.name, entry.name);
    }
  }

  // Topological sort using Kahn's algorithm. NORMAL is seeded first so it
  // leaves the queue as early as its own constraints allow.
  const inDegree = new Map<MiddlewareName, number>();
  inDegree.set(NORMAL, 0);
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

  // Any entry left with a positive in-degree is on a cycle or blocked by one
  if (sorted.length !== entries.length) {
    const remaining = new Set<MiddlewareName>();
    for (const [name, degree] of inDegree) {
      if (degree > 0) remaining.add(name);
    }

    // Every remaining node has at least one remaining predecessor (otherwise
    // its in-degree would have dropped to 0), so walking predecessors must
    // eventually revisit a node and expose the cycle.
    const predecessors = new Map<MiddlewareName, MiddlewareName>();
    for (const [source, targets] of edges) {
      if (!remaining.has(source)) continue;
      for (const target of targets) {
        if (remaining.has(target)) predecessors.set(target, source);
      }
    }

    const path: MiddlewareName[] = [];
    const indexOf = new Map<MiddlewareName, number>();
    let node = remaining.values().next().value!;
    while (!indexOf.has(node)) {
      indexOf.set(node, path.length);
      path.push(node);
      node = predecessors.get(node)!;
    }
    const cycle = path.slice(indexOf.get(node));
    const trail = [...cycle, node].map(String).join(' -> ');
    throw new Error(`Middleware dependency cycle detected: ${trail}`);
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
export function withRetry(maxRetries: number, opts?: RetryOptions) {
  return {
    name: 'builtin:retry' as const,
    middleware: createRetry(maxRetries, opts),
  };
}

/**
 * Creates a timeout middleware configuration using AbortSignal.
 *
 * Name: 'builtin:timeout'
 * Position: inner of 'builtin:retry' — the timeout wraps each retry attempt
 * individually, so every attempt gets a fresh time budget (per-attempt
 * semantics, matching ky) instead of one budget shared across all attempts.
 *
 * Each call creates a fresh `AbortSignal.timeout(ms)` and combines it with
 * any signal already on the request init via `AbortSignal.any` (Node.js
 * >= 20.3.0 or a modern browser). A timeout abort is rethrown as
 * {@link TimeoutError} with the underlying `DOMException` as `cause`;
 * user-initiated aborts (`AbortError`) propagate unchanged.
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
    inner: 'builtin:retry' as const,
    middleware: (f: typeof globalThis.fetch) => applyTimeout(f, ms),
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
    middleware: ((f) => (input, init) => {
      // `new Headers(...)` interops with every HeadersInit shape; the
      // previous plain-object spread silently dropped headers already
      // packed into a Headers instance. Native fetch accepts the
      // instance directly.
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return f(input, { ...init, headers });
    }) as MiddlewareFn,
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
    // `as typeof NORMAL` keeps the unique-symbol type; the bare literal
    // would widen to `symbol`, which is not a valid MiddlewareName.
    outer: NORMAL as typeof NORMAL,
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

/**
 * Progress snapshot handed to {@link withProgress} callbacks.
 */
export type ProgressState = {
  /** Fraction of the body transferred, in `[0, 1]`. Always `0` while the
   * total size is unknown (no `Content-Length` header, or a stream body
   * without a known length). */
  percent: number;
  /** Bytes transferred so far (this attempt's body). */
  transferred: number;
  /** Total bytes, from `Content-Length` for downloads. `0` when unknown —
   * likewise for uploads, since a streaming request body carries no size. */
  total: number;
}

/**
 * Options for {@link withProgress}.
 */
export type ProgressOptions = {
  /**
   * Called for every downloaded chunk, right before it is forwarded to the
   * consumer. `total` comes from the response's `Content-Length` (parsed as
   * a non-negative integer; anything missing or malformed counts as
   * unknown and reports `total: 0` with `percent: 0`). Null-body responses
   * (`204`/`205`/`HEAD`, …) never reach this callback.
   */
  onDownloadProgress?: (progress: ProgressState, chunk: Uint8Array) => void;
  /**
   * Called for every chunk read from the request body.
   *
   * Only a `ReadableStream` request body can be observed: every other body
   * shape (string, BufferSource, Blob, URLSearchParams, FormData) is passed
   * through untouched and never triggers this callback — the library does
   * not serialize request bodies just to count them. Note that native
   * `fetch` requires `duplex: 'half'` for stream bodies, which callers
   * must set themselves. Like downloads, `total` is `0` (and `percent`
   * stays `0`) because a stream's length is not known up front.
   */
  onUploadProgress?: (progress: ProgressState, chunk: Uint8Array) => void;
}

/**
 * Wraps `body` in a counting stream, reporting each chunk via `onProgress`
 * with the known `total` (from `contentLength`) folded into `percent`.
 */
function trackStream(
  body: ReadableStream<Uint8Array>,
  contentLength: number,
  onProgress: (progress: ProgressState, chunk: Uint8Array) => void
): ReadableStream<Uint8Array> {
  let transferred = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transferred += chunk.byteLength;
        onProgress(
          {
            percent:
              contentLength > 0
                ? Math.min(transferred / contentLength, 1)
                : 0,
            transferred,
            total: contentLength,
          },
          chunk
        );
        controller.enqueue(chunk);
      },
    })
  );
}

/**
 * Creates a download/upload progress-reporting middleware configuration.
 *
 * Name: 'builtin:progress'
 * Position: inner of NORMAL — progress sits inside the NORMAL group and
 * therefore inside retry: every (re)try reports its own progress from
 * zero, and counters restart when a discarded attempt is retried.
 *
 * Downloads are observed by piping `response.body` through a counting
 * `TransformStream` and rebuilding the response with its original
 * `status`/`statusText`/`headers` — the returned `Response` behaves like
 * the original (its `body` is a new stream, so it can only be read once,
 * exactly like the original). Null-body responses (`204`/`205`/`HEAD`, …,
 * anything with `body == null`) are returned untouched and produce no
 * callbacks. `total` comes from `Content-Length`; without it `total` is
 * `0` and `percent` stays `0` while `transferred` still counts bytes.
 *
 * Uploads are counted only when the request `init.body` is already a
 * `ReadableStream` (see {@link ProgressOptions.onUploadProgress}).
 *
 * Callbacks fire while the body streams — i.e. after the fetch call has
 * resolved — so they must not throw for a request to succeed.
 *
 * @param opts - Progress callbacks
 * @returns A middleware configuration with proper naming and positioning
 *
 * @example
 * ```ts
 * client.pipe(use, withProgress({
 *   onDownloadProgress: ({ percent, transferred, total }) =>
 *     console.log(`download ${(percent * 100).toFixed(1)}%`, transferred, total),
 *   onUploadProgress: ({ transferred }) => console.log('sent', transferred),
 * }))
 * ```
 */
export function withProgress(opts: ProgressOptions = {}) {
  return {
    name: 'builtin:progress' as const,
    // `as typeof NORMAL` keeps the unique-symbol type; the bare literal
    // would widen to `symbol`, which is not a valid MiddlewareName.
    inner: NORMAL as typeof NORMAL,
    middleware: ((f, _o) =>
      async (input, init) => {
        let nextInit = init;
        if (opts.onUploadProgress && init?.body instanceof ReadableStream) {
          // A wrapped body keeps streaming: no Content-Length claim, no
          // serialization — total stays unknown (0), percent stays 0.
          nextInit = {
            ...init,
            body: trackStream(init.body, 0, opts.onUploadProgress),
          };
        }

        const res = await f(input, nextInit);

        if (!opts.onDownloadProgress || res.body == null) {
          // Null-body responses (204/205/HEAD, …) must stay null-body —
          // wrapping would fabricate an empty stream and change semantics.
          return res;
        }

        const contentLength = Number(res.headers.get('Content-Length'));
        return new Response(
          trackStream(
            res.body,
            Number.isFinite(contentLength) && contentLength > 0
              ? contentLength
              : 0,
            opts.onDownloadProgress
          ),
          {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }
        );
      }) as MiddlewareFn,
  };
}
