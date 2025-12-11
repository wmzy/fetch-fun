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
 * Configuration options for fetch requests.
 * Extends RequestInit with additional properties for URL handling, middleware, etc.
 */
export type Options = Omit<RequestInit, 'headers'> & {
  /** HTTP headers as a simple key-value object */
  headers?: Record<string, string>;
  /** Request URL path (combined with baseUrl if present) */
  url?: string;
  /** Base URL prefix for all requests */
  baseUrl?: string;
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
export type Client = Options & Pipe;

/**
 * A fetchable configuration that has a required URL.
 * This type is required for making actual fetch requests.
 */
export type Fetchable = { url: string } & Options;
