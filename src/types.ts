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
 * const loggingMiddleware: Middleware = (f, instance) =>
 *   (...params) => {
 *     console.log('Fetching:', params);
 *     return f(...params);
 *   };
 * ```
 */
export type Middleware = (f: typeof fetch, instance: Fetchable) => typeof fetch;

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
 */
export type AppendQueryType<
  Q,
  K extends string,
  V extends string
> = IsEmptyOrIndexed<Q> extends true
  ? { [P in K]: V }
  : Prettify<{
      [P in keyof Q | K]: P extends K
        ? P extends keyof Q
          ? Q[P] extends string[]
            ? [...Q[P], V]
            : Q[P] extends string
            ? [Q[P], V]
            : V
          : V
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
 */
export type SetQueryType<
  Q,
  K extends string,
  V extends string
> = IsEmptyOrIndexed<Q> extends true
  ? { [P in K]: V }
  : Prettify<Omit<Q, K> & Record<K, V>>;

/**
 * URLSearchParams with type information for IDE hints.
 * The phantom type Q tracks the query parameter types at compile time.
 */
export type TypedURLSearchParams<Q extends QueryType = QueryType> =
  URLSearchParams & { _type?: Prettify<Q> };

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
  /** Array of middleware functions to apply */
  middlewares?: Middleware[];
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
};

/**
 * Pipe function type for fluent API chaining.
 * Allows calling configuration functions in a chainable manner.
 *
 * @example
 * ```ts
 * client.pipe(url, '/users').pipe(method, 'GET').pipe(fetch)
 * ```
 */
export type PipeFn = <T extends Pipe, const P extends any[], R>(
  this: T,
  action: (o: T, ...p: P) => R,
  ...params: P
) => R;

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
 */
export type Fetchable<Q extends QueryType = QueryType> = {
  url: string;
} & Options<Q>;
