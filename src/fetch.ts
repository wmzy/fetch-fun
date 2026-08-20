import { json } from './config';
import { HTTPError } from './errors';
import { sortMiddlewares } from './middleware';
import type { Fetchable, Pipe, ReaderData, ResolveData } from './types';
import { getData, hasData, applyTimeout } from './util';

/**
 * Reports whether `url` parses as an absolute URL (i.e. carries its own
 * protocol), in which case it bypasses `baseUrl` entirely.
 */
function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Joins `baseUrl` and `url` with slash normalization:
 *
 * - No `baseUrl` → `url` is used as-is.
 * - Absolute `url` (own protocol, e.g. `https://…`) → `baseUrl` is ignored.
 * - Otherwise trailing slashes on `baseUrl` and leading slashes on `url`
 *   are collapsed to a single `/` separator, so neither a double slash nor
 *   a missing slash can occur.
 *
 * A `baseUrl` that carries its own query string is not supported — use the
 * `query`/`mergeQuery` config functions instead.
 */
function joinUrl(baseUrl: string | undefined, url: string): string {
  if (!baseUrl) return url;
  if (isAbsoluteUrl(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Converts a Fetchable configuration to fetch parameters.
 *
 * Extracts the URL (combining baseUrl and url with slash normalization —
 * see {@link joinUrl}) and RequestInit options from the configuration
 * object.
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
    timeoutMs,
    ...rest
  } = o as Fetchable & Pipe;

  // Build final URL: baseUrl + url + searchParams
  let finalUrl = joinUrl(baseUrl, url);

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
 * When `timeout()` set a `timeoutMs` budget, an innermost built-in layer
 * wraps the base fetch so every attempt — including each retry by an outer
 * middleware — gets a fresh `AbortSignal.timeout`, combined with any user
 * `signal` via `AbortSignal.any` (Node.js >= 20.3.0). Without a budget this
 * is a zero-overhead pass-through.
 *
 * @param f - The base fetch function
 * @param o - The fetchable configuration containing middlewares
 * @returns The fetch function with all middlewares applied
 */
export function applyMiddlewares(f: typeof globalThis.fetch, o: Fetchable) {
  const entries = o.middlewares || [];
  const sorted = sortMiddlewares(entries);
  const innermost =
    o.timeoutMs != null ? applyTimeout(f, o.timeoutMs) : f;
  // Apply from last to first so that the first middleware is the outermost
  return sorted.reduceRight((f, entry) => entry.middleware(f, o), innermost);
}

/**
 * Executes a fetch request with the given configuration.
 *
 * Applies all configured middlewares and makes the HTTP request.
 * This is the raw escape hatch: it never throws on non-2xx statuses —
 * the returned `Response` always resolves. Use `fetchData`/`fetchJSON`
 * for automatic `HTTPError` throwing instead.
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
 * Builds a {@link Request} for error reporting on a best-effort basis.
 *
 * Returns `undefined` when the `Request` constructor rejects the parameters,
 * e.g. when the body is a one-shot stream or a GET carries a body.
 *
 * @param o - The fetchable configuration
 * @returns The reconstructed request, or `undefined` on failure
 */
function bestEffortRequest(o: Fetchable): Request | undefined {
  try {
    const [url, init] = toFetchParams(o);
    return new Request(url, init);
  } catch {
    return undefined;
  }
}

/**
 * Executes a fetch request and extracts the parsed data.
 *
 * Requires a data reader middleware (like `json`, `text`, or `blob`) to be configured.
 * Use `getData()` to retrieve the parsed data from the response.
 *
 * Throws an {@link HTTPError} when the response has a non-2xx status
 * (`!response.ok`). If a data reader middleware already parsed the error
 * body, the parsed value is attached to `error.data`. To opt out and
 * handle statuses yourself, use `fetch()` and inspect the raw `Response`.
 *
 * The return type is inferred from the reader attached earlier in the pipe
 * (e.g. `pipe(data, reader)`, `pipe(json)`, or converged by
 * `pipe(validate, schema)`); without a reader it resolves to `unknown`.
 * An explicit type argument still wins when provided.
 *
 * @template T - Optional override for the resolved data type
 * @template O - The fetchable configuration type (inferred)
 * @param o - The fetchable configuration with a data reader
 * @returns A Promise resolving to the parsed data
 * @throws {HTTPError} When the response status is not ok
 *
 * @example
 * ```ts
 * const users = await client
 *   .pipe(url, '/users')
 *   .pipe(json)
 *   .pipe(fetchData);
 * ```
 */
export async function fetchData<T = never, O extends Fetchable = Fetchable>(
  o: O
): Promise<ResolveData<T, O>> {
  const res = await fetch(o);
  if (!res.ok) {
    const err = new HTTPError(res, bestEffortRequest(o));
    // Attach the parsed error body when a data reader middleware stored it.
    err.data = hasData(res) ? getData(res) : undefined;
    throw err;
  }
  return getData<ReaderData<O>>(res) as ResolveData<T, O>;
}

/**
 * Executes a fetch request and parses the response as JSON.
 *
 * Convenience function that combines `json` middleware with `fetchData`.
 * Throws an {@link HTTPError} when the response has a non-2xx status,
 * with the parsed JSON error body attached to `error.data`.
 *
 * The return type follows the reader chain: an explicit type argument wins
 * when provided, a schema attached via `pipe(validate, schema)` converges to
 * its output type, and otherwise `json`'s reader resolves to `unknown`.
 *
 * @template T - Optional override for the resolved JSON type
 * @template O - The fetchable configuration type (inferred)
 * @param o - The fetchable configuration
 * @returns A Promise resolving to the parsed JSON data
 * @throws {HTTPError} When the response status is not ok
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
export function fetchJSON<T = never, O extends Fetchable = Fetchable>(
  o: O
): Promise<ResolveData<T, O>> {
  return fetchData(json(o)) as Promise<ResolveData<T, O>>;
}
