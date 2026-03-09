import { json } from './config';
import { sortMiddlewares } from './middleware';
import type { Fetchable, Pipe } from './types';
import { getData } from './util';

/**
 * Converts a Fetchable configuration to fetch parameters.
 *
 * Extracts the URL (combining baseUrl and url) and RequestInit options
 * from the configuration object.
 *
 * @param o - The fetchable configuration
 * @returns A tuple of [url, requestInit] for use with fetch
 *
 * @example
 * ```ts
 * const [url, init] = toFetchParams(config);
 * // url: 'https://api.example.com/users'
 * // init: { method: 'GET', headers: {...} }
 * ```
 */
export function toFetchParams(o: Fetchable): [string, RequestInit] {
  const {
    baseUrl,
    url,
    searchParams,
    fetch,
    middlewares,
    pipe,
    add,
    with: w,
    ...rest
  } = o as Fetchable & Pipe;

  // Build final URL: baseUrl + url + searchParams
  let finalUrl = baseUrl ? `${baseUrl}${url}` : url;

  if (searchParams && searchParams.size > 0) {
    const separator = finalUrl.includes('?') ? '&' : '?';
    finalUrl = `${finalUrl}${separator}${searchParams.toString()}`;
  }

  return [finalUrl, rest];
}

/**
 * Applies all middlewares to the fetch function.
 *
 * Middlewares are sorted based on their positioning constraints (outer/inner)
 * before being applied. This ensures the onion model is respected:
 * - Outer middlewares wrap inner middlewares
 * - The first middleware in the sorted list is the outermost
 *
 * @param f - The base fetch function
 * @param o - The fetchable configuration containing middlewares
 * @returns The fetch function with all middlewares applied
 */
export function applyMiddlewares(f: typeof globalThis.fetch, o: Fetchable) {
  const entries = o.middlewares || [];
  const sorted = sortMiddlewares(entries);
  // Apply from last to first so that the first middleware is outermost
  return sorted.reduceRight((f, entry) => entry.middleware(f, o), f);
}

/**
 * Executes a fetch request with the given configuration.
 *
 * Applies all configured middlewares and makes the HTTP request.
 *
 * @param o - The fetchable configuration (must include url)
 * @returns A Promise resolving to the Response
 *
 * @example
 * ```ts
 * const response = await client
 *   .pipe(url, '/users')
 *   .pipe(method, 'GET')
 *   .pipe(fetch);
 * ```
 */
export function fetch(o: Fetchable) {
  const f = o.fetch || globalThis.fetch;
  return applyMiddlewares(f, o)(...toFetchParams(o));
}

/**
 * Executes a fetch request and extracts the parsed data.
 *
 * Requires a data reader middleware (like `json`, `text`, or `blob`) to be configured.
 * Use `getData()` to retrieve the parsed data from the response.
 *
 * @template T - The expected data type
 * @param o - The fetchable configuration with a data reader
 * @returns A Promise resolving to the parsed data
 *
 * @example
 * ```ts
 * const users = await client
 *   .pipe(url, '/users')
 *   .pipe(json)
 *   .pipe(fetchData);
 * ```
 */
export function fetchData<T = unknown>(o: Fetchable): Promise<T> {
  return fetch(o).then(getData<T>);
}

/**
 * Executes a fetch request and parses the response as JSON.
 *
 * Convenience function that combines `json` middleware with `fetchData`.
 *
 * @template T - The expected JSON data type
 * @param o - The fetchable configuration
 * @returns A Promise resolving to the parsed JSON data
 *
 * @example
 * ```ts
 * type User = { id: number; name: string };
 *
 * const users = await client
 *   .pipe(url, '/users')
 *   .pipe(fetchJSON<User[]>);
 * ```
 */
export function fetchJSON<T = unknown>(o: Fetchable): Promise<T> {
  return fetchData<T>(json(o));
}
