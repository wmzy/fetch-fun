import { mapErrorSymbol, readDataSymbol } from './constants';

/**
 * HTTP request method types.
 * Includes common methods and allows custom string values.
 */
export type Method =
  | 'POST'
  | 'GET'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'
  | (string & {});

/**
 * Middleware function type for intercepting and modifying fetch behavior.
 * Middlewares wrap the fetch function to add custom logic like retry, logging, etc.
 *
 * @param f - The fetch function to wrap
 * @param instance - The current fetchable configuration
 * @returns A wrapped fetch function
 *
 * @example
 * ```ts
 * const loggingMiddleware: MiddlewareFn = (f, instance) =>
 *   (...params) => {
 *     console.log('Fetching:', params);
 *     return f(...params);
 *   };
 * ```
 */
export type MiddlewareFn = (
  f: typeof fetch,
  instance: Fetchable
) => typeof fetch;

/**
 * Symbol representing the default/normal position in middleware ordering.
 * Middlewares without explicit positioning are placed at NORMAL position.
 */
export const NORMAL: unique symbol = Symbol('normal');

/**
 * Middleware position identifier.
 * - `typeof NORMAL`: Default position for middlewares
 * - `builtin:${string}`: Built-in middleware namespace (e.g., 'builtin:retry', 'builtin:timeout')
 * - `string & {}`: Custom user-defined middleware names
 */
export type MiddlewareName =
  | typeof NORMAL
  | `builtin:${string}`
  | (string & {});

/**
 * Configuration object for a middleware with positioning.
 *
 * The onion model means:
 * - `outer: 'builtin:retry'` = This middleware wraps retry (executes before retry on request, after on response)
 * - `inner: 'builtin:retry'` = This middleware is wrapped by retry (executes after retry on request, before on response)
 *
 * @example
 * ```ts
 * // Timeout should wrap retry (outer)
 * {
 *   name: 'builtin:timeout',
 *   outer: 'builtin:retry',
 *   middleware: createTimeout(5000),
 * }
 *
 * // Auth should be inside retry (inner) - each retry attempt includes auth
 * {
 *   name: 'builtin:auth',
 *   inner: 'builtin:retry',
 *   middleware: createAuth(token),
 * }
 * ```
 */
export type MiddlewareConfig = {
  /** Unique name for this middleware (used for positioning by other middlewares) */
  name?: MiddlewareName;
  /** Place this middleware outside (wrapping) the specified middleware */
  outer?: MiddlewareName;
  /** Place this middleware inside (wrapped by) the specified middleware */
  inner?: MiddlewareName;
  /** The actual middleware function */
  middleware: MiddlewareFn;
};

/**
 * Input type for adding middleware.
 * Can be a simple middleware function or a configuration object with positioning.
 */
export type MiddlewareInput = MiddlewareFn | MiddlewareConfig;

/**
 * Internal middleware entry with resolved positioning.
 */
export type MiddlewareEntry = {
  name: MiddlewareName;
  outer?: MiddlewareName;
  inner?: MiddlewareName;
  middleware: MiddlewareFn;
};

/**
 * @deprecated Use MiddlewareFn instead
 */
export type Middleware = MiddlewareFn;

/**
 * Branded middleware entry type for better IDE display.
 * Shows as MW<"builtin:retry"> instead of MiddlewareEntry.
 */
export type MW<Name extends string = string> = MiddlewareEntry & {
  readonly __brand?: Name;
};

/**
 * Infer middleware name from MiddlewareInput.
 * Returns the name string if provided, otherwise 'unknown'.
 */
export type InferMiddlewareName<M extends MiddlewareInput> =
  M extends MiddlewareFn
    ? 'unknown'
    : M extends { name: infer N extends string }
      ? N
      : 'unknown';

/**
 * Map an array of MiddlewareInput to a tuple of MW with inferred names.
 */
export type MapMiddlewares<T extends readonly MiddlewareInput[]> = {
  [K in keyof T]: MW<InferMiddlewareName<T[K]>>;
};

/**
 * Type-level representation of query parameters.
 * Used as a phantom type to track query parameter types at compile time.
 * Values can be single strings or arrays for repeated keys.
 */
export type QueryType = Record<string, string | string[]>;

/**
 * Helper type to append a value to an existing query type.
 * Handles the case where a key already exists (converts to array).
 * Uses Prettify to ensure the result is expanded for IDE hints.
 * Handles empty objects specially to avoid index signature pollution.
 * Non-string values are tracked as their stringified form (`${V}`).
 */
export type AppendQueryType<
  Q,
  K extends string,
  V extends string | number | boolean
> = IsEmptyOrIndexed<Q> extends true
  ? Record<K, `${V}`>
  : Prettify<{
      [P in keyof Q | K]: P extends K
        ? P extends keyof Q
          ? Q[P] extends string[]
            ? [...Q[P], `${V}`]
            : Q[P] extends string
            ? [Q[P], `${V}`]
            : `${V}`
          : `${V}`
        : P extends keyof Q
        ? Q[P]
        : never;
    }>;

/**
 * Forces TypeScript to expand/simplify a type for better IDE display.
 * Converts complex nested types into their flattened form.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Check if a type is an empty object or has index signature.
 */
type IsEmptyOrIndexed<T> = string extends keyof T
  ? true
  : keyof T extends never
  ? true
  : false;

/**
 * Helper type to set a value in a query type (replaces existing).
 * Uses Prettify to ensure the result is expanded for IDE hints.
 * Handles empty objects specially to avoid index signature pollution.
 * Non-string values are tracked as their stringified form (`${V}`).
 */
export type SetQueryType<
  Q,
  K extends string,
  V extends string | number | boolean
> = IsEmptyOrIndexed<Q> extends true
  ? Record<K, `${V}`>
  : Prettify<Omit<Q, K> & Record<K, `${V}`>>;

/**
 * URLSearchParams with type information for IDE hints.
 * The phantom type Q tracks the query parameter types at compile time.
 */
export type TypedURLSearchParams<Q extends QueryType = QueryType> =
  URLSearchParams & { _type?: Prettify<Q> };

/**
 * Extracts every `{name}` placeholder name from a path template string.
 *
 * Recursively walks the template literal type, so `'/a/{x}/b/{y}'` yields
 * `'x' | 'y'` and a template without placeholders yields `never`.
 */
export type ExtractPlaceholders<T extends string> =
  T extends `${string}{${infer Name}}${infer Rest}`
    ? Name | ExtractPlaceholders<Rest>
    : never;

/**
 * The exact params object `fillPath` and `path` require for a template:
 * one entry per `{name}` placeholder, and nothing else.
 *
 * The mapped type makes every placeholder a **required** key (a missing one
 * is a compile error), while object-literal excess property checking rejects
 * keys the template does not mention.
 */
export type PlaceholderParams<T extends string> = Record<
  ExtractPlaceholders<T>,
  string | number
>;

/**
 * Configuration options for fetch requests.
 * Extends RequestInit with additional properties for URL handling, middleware, etc.
 *
 * @template Q - Type parameter for tracking query parameter types via searchParams
 */
export type Options<Q extends QueryType = QueryType> = Omit<
  RequestInit,
  'headers'
> & {
  /** HTTP headers as a simple key-value object */
  headers?: Record<string, string>;
  /** Request URL path (combined with baseUrl if present) */
  url?: string;
  /** Base URL prefix for all requests */
  baseUrl?: string;
  /** Query parameters to append to the URL (combined in toFetchParams). Carries type information for IDE hints. */
  searchParams?: TypedURLSearchParams<Q>;
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof fetch;
  /** Array of middleware entries with positioning information */
  middlewares?: MiddlewareEntry[];
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  /**
   * Per-request timeout budget in milliseconds. Stored by `timeout()` and
   * applied when the request executes: each attempt (including each retry)
   * gets a fresh `AbortSignal.timeout(ms)` combined with `signal` via
   * `AbortSignal.any` (Node.js >= 20.3.0).
   */
  timeoutMs?: number;
  /**
   * Whole-request timeout budget in milliseconds covering all retry
   * attempts. Stored by `totalTimeout()` and applied when the request
   * executes: a single `AbortSignal.timeout(ms)` spans the entire request
   * — every attempt plus the backoff delays between them — wrapped
   * around the whole middleware chain and combined with `signal` via
   * `AbortSignal.any` (Node.js >= 20.3.0).
   */
  totalTimeoutMs?: number;
};

/**
 * Pipe function type for fluent API chaining.
 *
 * The first signature is a fast path for actions that take a single function
 * argument (e.g. {@link data}'s reader). Typing the argument as
 * `A & ((res: Response) => unknown)` serves two purposes: it gives inline
 * arrow literals a contextual signature (so `(res)` is typed as `Response`
 * without an explicit annotation), and it lets the action's own generic
 * return type — the phantom reader brand — infer from the argument's true
 * type. The generic variadic path below cannot do the latter for
 * context-sensitive function literals.
 *
 * @example
 * ```ts
 * client.pipe(url, '/users').pipe(method, 'GET').pipe(fetch)
 * ```
 */
export type PipeFn = {
  <T extends Pipe, A, R>(
    this: T,
    action: (o: T, a: A) => R,
    a: A & ((res: Response) => unknown)
  ): R;
  <T extends Pipe, const P extends any[], R>(
    this: T,
    action: (o: T, ...p: P) => R,
    ...params: P
  ): R;
};

/**
 * Interface providing pipe methods for fluent API.
 * All three methods (pipe, add, with) are functionally identical.
 */
export type Pipe = {
  /** Primary pipe method for chaining operations */
  pipe: PipeFn;
  /**
   * Alias for pipe
   * @alias pipe
   */
  add: PipeFn;
  /**
   * Alias for pipe
   * @alias pipe
   */
  with: PipeFn;
};

/**
 * A configured client with both options and pipe methods.
 */
export type Client<Q extends QueryType = QueryType> = Options<Q> & Pipe;

/**
 * A fetchable configuration that has a required URL.
 * This type is required for making actual fetch requests.
 *
 * The optional `[readDataSymbol]` member mirrors the runtime reader slot set
 * by `data()`/`json()`/`text()`/`blob()`. It is optional here so unbranded
 * options remain valid fetchables; branded options carry the required form
 * and light up {@link ReaderData} inference in `fetchData`.
 *
 * The optional `[mapErrorSymbol]` member mirrors the error-mapper slot set
 * by `mapError()`.
 */
export type Fetchable<Q extends QueryType = QueryType> = {
  url: string;
} & Options<Q> & {
    [readDataSymbol]?: (res: Response) => unknown;
    [mapErrorSymbol]?: (e: unknown, ctx: MapErrorContext) => unknown;
  };

/**
 * Context handed to a `mapError` mapper: the failed `response` and the
 * originating `request` when the error is an `HTTPError`, and empty
 * otherwise (e.g. `NetworkError`, `TimeoutError`, `ValidationError`).
 */
export type MapErrorContext = { response?: Response; request?: Request };

/**
 * Result returned by a Standard Schema v1 `validate` function.
 *
 * On success `value` carries the validated (and possibly transformed or
 * defaulted) output. On failure `issues` is present and non-empty.
 *
 * @see {@link https://standardschema.dev | Standard Schema specification}
 */
export type StandardSchemaResult<Output = unknown> = {
  /** The validated output value (may be transformed/defaulted by the schema). */
  value?: Output;
  /** Validation issues; present and non-empty when validation failed. */
  issues?: readonly unknown[];
}

/**
 * Minimal subset of the Standard Schema v1 specification needed by
 * {@link validate}.
 *
 * Detected via duck typing at runtime, so schemas from Zod, Valibot,
 * ArkType or any other Standard Schema vendor work without adapters
 * or runtime dependencies.
 *
 * @see {@link https://standardschema.dev | Standard Schema specification}
 */
export type StandardSchema<Output = unknown> = {
  '~standard': {
    version: 1;
    vendor?: string;
    validate: (
      value: unknown
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  };
}

/**
 * Extracts the phantom response reader type stored on an options object via
 * the `[readDataSymbol]` slot (set by `data()` and its `json()`/`text()`/
 * `blob()` shortcuts, rewritten by `validate()`).
 *
 * Returns the reader's return type — usually a `Promise` — or `unknown` when
 * no reader is attached.
 */
export type ReaderOf<O> =
  O extends { [readDataSymbol]: (res: Response) => infer R } ? R : unknown;

/**
 * The data type a reader will produce: {@link ReaderOf} with `Promise`
 * unwrapped via `Awaited`, so both sync and async readers resolve to the
 * final value type.
 */
export type ReaderData<O> = Awaited<ReaderOf<O>>;

/**
 * Extracts the output type of a Standard Schema v1 schema.
 */
export type SchemaOutput<S> = S extends StandardSchema<infer O> ? O : never;

/**
 * Resolves the return type of `fetchData`/`fetchJSON`: when the caller
 * supplies an explicit type argument it wins; otherwise (`T` left at its
 * `never` sentinel default) the phantom reader's {@link ReaderData} flows
 * through. The tuple-wrapped conditional avoids distribution over `never`.
 */
export type ResolveData<T, O> = [T] extends [never] ? ReaderData<O> : T;
