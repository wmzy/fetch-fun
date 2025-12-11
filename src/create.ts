import type { Options, Pipe, PipeFn } from './types';

/**
 * Creates a new fetch client with fluent API support.
 *
 * The returned client provides `pipe`, `add`, and `with` methods for chaining
 * configuration functions. All three methods are functionally identical.
 *
 * @returns A new client with empty options and pipe methods
 *
 * @example
 * ```ts
 * // Create an empty client
 * const client = create();
 *
 * // Create with initial options
 * const client = create({
 *   baseUrl: 'https://api.example.com',
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 *
 * // Chain configuration using pipe
 * const result = await client
 *   .pipe(url, '/users')
 *   .pipe(method, 'GET')
 *   .pipe(fetchJSON);
 * ```
 */
export function create(): Options & Pipe;
/**
 * Creates a new fetch client with fluent API support.
 * @param o - Pass null to create an empty client
 * @returns A new client with empty options and pipe methods
 */
export function create(o: null): Options & Pipe;
/**
 * Creates a new fetch client with fluent API support.
 * @param o - Initial options to configure the client
 * @returns A new client with the provided options and pipe methods
 */
export function create<T extends Options>(o: T): T & Pipe;
export function create(o?: any): Options & Pipe {
  const pipe: PipeFn = function pipe(action, ...params) {
    return action(this, ...params);
  };

  return {
    ...o,
    pipe,
    add: pipe,
    with: pipe,
  };
}
