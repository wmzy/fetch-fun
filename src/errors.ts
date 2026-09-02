/**
 * Error classes thrown by fetch-fun executors.
 *
 * @module
 */

/**
 * Error thrown by `fetchData` (and its aliases like `fetchJSON`) when the
 * server responds with a non-2xx status (`response.ok === false`).
 *
 * Carries the failed `Response` and, when available, the originating
 * `Request`. If a data reader middleware (e.g. `json`) already parsed the
 * error body, that parsed value is attached to {@link HTTPError.data}.
 *
 * JSON-serializable: `JSON.stringify` picks up {@link HTTPError.toJSON}
 * and emits a plain object (`name`, `message`, `status`, `url`, `data`) —
 * safe to cross SSR → client or worker → main boundaries.
 *
 * @example
 * ```ts
 * try {
 *   await client.pipe(url, '/users/1').pipe(fetchJSON);
 * } catch (e) {
 *   if (e instanceof HTTPError) {
 *     console.log(e.status); // e.g. 404 — shorthand for response.status
 *     console.log(e.data); // parsed error body, e.g. { message: 'Not Found' }
 *   }
 * }
 * ```
 */
export class HTTPError extends Error {
  /**
   * The parsed error body, when a data reader middleware (e.g. `json`)
   * stored it before the error was thrown. `undefined` otherwise.
   */
  data?: unknown;

  constructor(
    /** The failed response (non-2xx status). */
    public response: Response,
    /** The originating request, when it could be reconstructed. */
    public request?: Request,
    options?: { cause?: unknown }
  ) {
    super(
      `${request?.method ?? 'GET'} ${request?.url ?? response.url} failed with status ${response.status} ${response.statusText}`.trim(),
      options
    );
    this.name = 'HTTPError';
  }

  /** HTTP status of the failed response — shorthand for `response.status`. */
  get status(): number {
    return this.response.status;
  }

  /**
   * Returns a clone of this error with `message` replaced — the ergonomic
   * way to swap in a human-readable message (e.g. from the parsed error
   * body) without losing the `HTTPError` identity: `instanceof` checks,
   * `status`, and `data` all keep working downstream. The original error
   * is untouched.
   *
   * The clone is created with this error as its prototype, so it inherits
   * **every** own field of the original — `response`, `request`, `data`,
   * `cause`, and anything a subclass or caller attached after
   * construction — instead of a hand-maintained copy list that would
   * silently miss fields added later. Only `message` is overridden.
   *
   * `stack` is inherited from the original as well: the clone reports the
   * original error's construction site, not a fresh stack captured at the
   * `withMessage` call.
   *
   * @example
   * ```ts
   * client.pipe(mapError, (e) =>
   *   e instanceof HTTPError ? e.withMessage(errorText(e.data)) : e,
   * );
   * ```
   */
  withMessage(message: string): HTTPError {
    // Prototype clone: inherits every own property of the original —
    // including fields this class does not know about — with only
    // `message` overridden as an own property.
    const clone = Object.create(this) as HTTPError;
    clone.message = message;
    return clone;
  }

  /** Plain-object shape emitted by `JSON.stringify` (no `Response`/`Request`). */
  toJSON(): {
    name: string;
    message: string;
    status: number;
    url: string;
    data?: unknown;
  } {
    return {
      name: this.name,
      message: this.message,
      status: this.response.status,
      url: this.response.url,
      data: this.data,
    };
  }
}

/**
 * Error thrown when the underlying fetch fails at the network level
 * (DNS lookup failure, connection refused, TLS error, offline, ...).
 *
 * Native fetch signals these failures by rejecting with a `TypeError`;
 * fetch-fun wraps that rejection in a {@link NetworkError} at the
 * innermost layer — directly around the base fetch — so consumers get a
 * typed error to branch on while the original `TypeError` is preserved as
 * `cause`. Errors thrown by user middleware are never mislabeled this
 * way, and aborts (`AbortError`) as well as timeouts ({@link TimeoutError})
 * propagate untouched.
 *
 * The {@link url} is extracted on a best-effort basis from the request
 * arguments and may be `undefined`.
 *
 * JSON-serializable: `JSON.stringify` picks up {@link NetworkError.toJSON}
 * and emits a plain object (`name`, `message`, `url`, `cause` reduced to
 * `{ name, message }`) — safe to cross SSR → client or worker → main
 * boundaries.
 *
 * @example
 * ```ts
 * try {
 *   await client.pipe(url, 'https://api.example.com/users').pipe(fetchJSON);
 * } catch (e) {
 *   if (e instanceof NetworkError) {
 *     console.log(e.url); // 'https://api.example.com/users' (best effort)
 *     console.log(e.cause); // the original TypeError from fetch
 *   }
 * }
 * ```
 */
export class NetworkError extends Error {
  constructor(
    /** Best-effort URL of the request that failed. */
    public url?: string,
    options?: { cause?: unknown; method?: string }
  ) {
    super(
      url == null
        ? 'network error'
        : `${options?.method ?? 'GET'} ${url} failed: network error`,
      options
    );
    this.name = 'NetworkError';
  }

  /** Plain-object shape emitted by `JSON.stringify`; non-`Error` causes are dropped. */
  toJSON(): {
    name: string;
    message: string;
    url?: string;
    cause?: { name: string; message: string };
  } {
    return {
      name: this.name,
      message: this.message,
      url: this.url,
      cause: causeToJSON(this.cause),
    };
  }
}

/**
 * Error thrown when a request exceeds its time budget.
 *
 * Reserved for the timeout middleware; exported now so consumers can
 * reference the type before that lands.
 *
 * JSON-serializable: `JSON.stringify` picks up {@link TimeoutError.toJSON}
 * and emits a plain object (`name`, `message`, `cause` reduced to
 * `{ name, message }`) — safe to cross SSR → client or worker → main
 * boundaries.
 *
 * @example
 * ```ts
 * try {
 *   await client.pipe(timeout, 5000).pipe(url, '/slow').pipe(fetch);
 * } catch (e) {
 *   if (e instanceof TimeoutError) {
 *     console.log('gave up after 5s');
 *   }
 * }
 * ```
 */
export class TimeoutError extends Error {
  constructor(message = 'Request timed out', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimeoutError';
  }

  /** Plain-object shape emitted by `JSON.stringify`; non-`Error` causes are dropped. */
  toJSON(): {
    name: string;
    message: string;
    cause?: { name: string; message: string };
  } {
    return {
      name: this.name,
      message: this.message,
      cause: causeToJSON(this.cause),
    };
  }
}

/**
 * Error thrown when response data fails Standard Schema validation
 * (see `validate`).
 *
 * Carries the raw schema `issues` (as produced by the validating library,
 * e.g. Zod/Valibot/ArkType issue objects) and the unvalidated `data` that
 * was rejected. A transformed/defaulted success value never throws — it
 * replaces the stored data instead.
 *
 * JSON-serializable: `JSON.stringify` picks up {@link ValidationError.toJSON}
 * and emits a plain object (`name`, `message`, `issues`, `data`) — safe to
 * cross SSR → client or worker → main boundaries and snapshot tests.
 *
 * @example
 * ```ts
 * try {
 *   const user = await client
 *     .pipe(url, '/users/1')
 *     .pipe(validate, UserSchema)
 *     .pipe(fetchJSON);
 * } catch (e) {
 *   if (e instanceof ValidationError) {
 *     console.log(e.issues); // e.g. [{ message: 'Expected string', path: [...] }]
 *     console.log(e.data); // the raw parsed body that failed
 *   }
 * }
 * ```
 */
export class ValidationError extends Error {
  constructor(
    /** The validation issues reported by the schema. */
    public issues: readonly unknown[],
    /** The unvalidated response data that failed the schema. */
    public data?: unknown,
    message?: string
  ) {
    super(message ?? issueMessage(issues) ?? 'Response data failed validation');
    this.name = 'ValidationError';
  }

  /** Plain-object shape emitted by `JSON.stringify`. */
  toJSON(): {
    name: string;
    message: string;
    issues: readonly unknown[];
    data?: unknown;
  } {
    return {
      name: this.name,
      message: this.message,
      issues: this.issues,
      data: this.data,
    };
  }
}

/**
 * Serializes an error `cause` for cross-boundary transport: `Error` causes
 * reduce to `{ name, message }`, anything else is dropped (`undefined`).
 */
function causeToJSON(
  cause: unknown
): { name: string; message: string } | undefined {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : undefined;
}

/**
 * Best-effort extraction of a human-readable message from the first issue.
 * Standard Schema issue objects (Zod, Valibot, ArkType, ...) carry a
 * `message` string; anything else falls back to `undefined`.
 */
function issueMessage(issues: readonly unknown[]): string | undefined {
  const first = issues[0];
  if (first != null && typeof first === 'object') {
    const message = (first as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}
