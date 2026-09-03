import type {
  Fetchable,
  MapErrorContext,
  MiddlewareEntry,
  Pipe,
  ReaderData,
  ResolveData,
} from './types';

import { json } from './config';
import { mapErrorSymbol } from './constants';
import { HTTPError, NetworkError } from './errors';
import { sortMiddlewares } from './middleware';
import {
  getData,
  hasData,
  applyTimeout,
  applyTotalTimeout,
  requestMethodOf,
} from './util';

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
 * - Protocol-relative `url` (e.g. `//cdn.example.com/x`) also bypasses
 *   `baseUrl`: it inherits the caller's protocol and is passed through
 *   untouched (`new URL` cannot parse it standalone, so it must be
 *   checked before the relative-path branch strips its leading slashes).
 * - Otherwise trailing slashes on `baseUrl` and leading slashes on `url`
 *   are collapsed to a single `/` separator, so neither a double slash nor
 *   a missing slash can occur.
 *
 * A `baseUrl` that carries its own query string is not supported — use the
 * `query`/`mergeQuery` config functions instead.
 */
function joinUrl(baseUrl: string | undefined, url: string): string {
  if (!baseUrl) return url;
  // Protocol-relative URLs bypass baseUrl — they are not relative paths.
  if (url.startsWith('//')) return url;
  if (isAbsoluteUrl(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Option keys `toFetchParams` consumes itself before the remainder is
 * handed to fetch as `RequestInit`.
 */
const LIBRARY_OPTION_KEYS =
  'baseUrl,url,searchParams,fetch,middlewares,pipe,add,with,timeoutMs,totalTimeoutMs'.split(
    ','
  );

/**
 * The `RequestInit` fields native fetch understands — plus `dispatcher`
 * (undici) and `duplex` (stream bodies), which the DOM lib types lag
 * behind on. Anything else riding on the options object is unrecognized:
 * it is not a fetch-fun option and fetch will ignore it.
 */
const REQUEST_INIT_KEYS =
  'method,headers,body,mode,credentials,cache,redirect,referrer,referrerPolicy,integrity,keepalive,signal,window,dispatcher,duplex'.split(
    ','
  );

const KNOWN_OPTION_KEYS = new Set([...LIBRARY_OPTION_KEYS, ...REQUEST_INIT_KEYS]);

/**
 * Development-only diagnostic: names every option key that is neither a
 * fetch-fun option nor a `RequestInit` field, so a typo like
 * `customeHeader` (or a stale key after a rename) is visible instead of
 * silently riding the config into fetch's blind spot. Silent in
 * production — bundlers that replace `process.env.NODE_ENV` fold the
 * call site's guard to `false` and drop this path entirely.
 */
function warnUnknownOptionKeys(rest: RequestInit): void {
  for (const key of Object.keys(rest)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      console.warn(
        `fetch-fun: ignoring unknown option "${String(key)}" — it is neither a fetch-fun option nor a RequestInit field, so fetch will not receive it`
      );
    }
  }
}

/**
 * Converts a Fetchable configuration to fetch parameters.
 *
 * Extracts the URL (combining baseUrl and url with slash normalization —
 * see {@link joinUrl}) and RequestInit options from the configuration
 * object. Keys that are neither fetch-fun options nor `RequestInit`
 * fields pass through to fetch untouched and unnoticed by the types —
 * in development (non-production `NODE_ENV`) each one logs a `console.warn`.
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
    totalTimeoutMs,
    ...rest
  } = o as Fetchable & Pipe;

  // Dev-only diagnostics; erased by production bundling.
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    warnUnknownOptionKeys(rest);
  }

  // Build final URL: baseUrl + url + searchParams
  let finalUrl = joinUrl(baseUrl, url);

  if (searchParams && searchParams.size > 0) {
    const separator = finalUrl.includes('?') ? '&' : '?';
    finalUrl = `${finalUrl}${separator}${searchParams.toString()}`;
  }

  return [finalUrl, rest];
}

/**
 * Best-effort extraction of the request URL from fetch arguments, for
 * {@link NetworkError} reporting: strings pass through, `URL` uses its
 * normalized href, and `Request` exposes its target URL.
 */
function requestUrlOf(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wraps the base fetch function so network-level failures reject with a
 * typed {@link NetworkError} instead of a bare `TypeError`.
 *
 * This wrapping sits at the innermost layer — directly around the base
 * fetch — so only errors thrown by fetch itself are relabeled; a
 * `TypeError` escaping user middleware propagates untouched. Aborts are
 * excluded too: when the request's signal has fired, the rejection is
 * rethrown unchanged (an `AbortError`, or whatever the runtime produced
 * around the abort) instead of being mislabeled as a network failure.
 *
 * @param f - The base fetch function
 * @returns A fetch function that rejects with NetworkError on transport
 *   failures
 */
function applyNetworkError(
  f: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await f(input, init);
    } catch (e) {
      if (e instanceof TypeError && !init?.signal?.aborted) {
        throw new NetworkError(requestUrlOf(input), {
          cause: e,
          method: requestMethodOf(input, init),
        });
      }
      throw e;
    }
  };
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
 * middleware — gets a fresh timeout signal, combined with any user
 * `signal` (natively `AbortSignal.any` on Node.js >= 20.3.0, an equivalent
 * manual composition on older runtimes). Without a budget this
 * is a zero-overhead pass-through.
 *
 * When `totalTimeout()` set a `totalTimeoutMs` budget, an outermost built-in
 * layer wraps the fully applied chain (outside every middleware, including
 * retry), so the budget spans all attempts and the backoff delays between
 * them; elapsing it aborts the in-flight attempt and rejects with a
 * {@link TimeoutError}. The two layers compose — the per-attempt layer
 * nests its own `AbortSignal.any` inside the whole-request one.
 *
 * Independently of the budget, the base fetch itself is wrapped by
 * {@link applyNetworkError} so network-level `TypeError` rejections surface
 * as {@link NetworkError} — inside the middleware chain, so user middleware
 * errors keep their original identity.
 *
 * Results are memoized per middlewares-array reference: configs are
 * immutable (every `pipe` copies), so the array reference identifies a
 * client's middleware set and the sort never reruns for it. Middleware
 * functions receive — and may capture — the very `o` they are applied with
 * (`retry` reads `o.signal`, `logging` reads `o.url`), so a fully built
 * chain is only reused when it was built from the identical config, base
 * fetch, and timeout budgets.
 *
 * @param f - The base fetch function
 * @param o - The fetchable configuration containing middlewares
 * @returns The fetch function with all middlewares applied
 */

// Shared key for middleware-less configs so they hit the cache too instead
// of allocating a fresh (always-empty) array per request.
const EMPTY_MIDDLEWARES: MiddlewareEntry[] = [];

// Applied-chain cache keyed by the middlewares array reference. Weak so a
// discarded client's entry is collected with it.
const appliedChainCache = new WeakMap<
  MiddlewareEntry[],
  {
    sorted: MiddlewareEntry[];
    built?: {
      f: typeof globalThis.fetch;
      o: Fetchable;
      timeoutMs: number | undefined;
      totalTimeoutMs: number | undefined;
      wrapped: typeof globalThis.fetch;
    };
  }
>();

export function applyMiddlewares(f: typeof globalThis.fetch, o: Fetchable) {
  const entries = o.middlewares || EMPTY_MIDDLEWARES;
  let cache = appliedChainCache.get(entries);
  if (!cache) {
    cache = { sorted: sortMiddlewares(entries) };
    appliedChainCache.set(entries, cache);
  }
  const { sorted, built } = cache;
  if (
    built &&
    built.f === f &&
    built.o === o &&
    built.timeoutMs === o.timeoutMs &&
    built.totalTimeoutMs === o.totalTimeoutMs
  ) {
    return built.wrapped;
  }
  const base = applyNetworkError(f);
  const innermost =
    o.timeoutMs != null ? applyTimeout(base, o.timeoutMs) : base;
  // Apply from last to first so that the first middleware is the outermost
  const chained = sorted.reduceRight(
    (f, entry) => entry.middleware(f, o),
    innermost
  );
  // The whole-request budget sits outside every middleware so it also
  // bounds the retry loop (attempts + backoff) as a single unit.
  const wrapped =
    o.totalTimeoutMs != null
      ? applyTotalTimeout(chained, o.totalTimeoutMs)
      : chained;
  cache.built = {
    f,
    o,
    timeoutMs: o.timeoutMs,
    totalTimeoutMs: o.totalTimeoutMs,
    wrapped,
  };
  return wrapped;
}

/**
 * Executes a fetch request with the given configuration.
 *
 * Applies all configured middlewares and makes the HTTP request.
 * This is the raw escape hatch: it never throws on non-2xx statuses —
 * the returned `Response` always resolves. Use `fetchData`/`fetchJSON`
 * for automatic `HTTPError` throwing instead. Network-level failures
 * (fetch rejecting with a `TypeError`, e.g. DNS or connection errors)
 * surface as a {@link NetworkError} with the original error preserved
 * as `cause`; aborts and timeouts keep their native/library identities.
 *
 * @param o - The fetchable configuration (must include url)
 * @returns A Promise resolving to the Response
 * @throws {NetworkError} When fetch itself fails at the network level
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
 * (`!response.ok`). Opaque responses from `no-cors` requests are the
 * exception: they report `status: 0` / `ok: false` yet are not errors,
 * so they do not throw — any problem reading the opaque body surfaces
 * naturally from the reader instead. For `no-cors` requests consider the
 * raw `fetch()` escape hatch to inspect the response yourself.
 * If a data reader middleware already parsed the error
 * body, the parsed value is attached to `error.data`. To opt out and
 * handle statuses yourself, use `fetch()` and inspect the raw `Response`.
 * Network-level failures (fetch rejecting with a `TypeError`) surface as
 * a {@link NetworkError} with the original error preserved as `cause`.
 *
 * The return type is inferred from the reader attached earlier in the pipe
 * (e.g. `pipe(data, reader)`, `pipe(json)`, or converged by
 * `pipe(validate, schema)`); without a reader it resolves to `unknown`.
 * An explicit type argument still wins when provided.
 *
 * When `mapError()` attached an error mapper, it runs here as the last
 * hop: the mapper's return value (awaited when async) is thrown instead
 * of the original error, whatever its type — with two guardrails: a
 * mapper returning `undefined` passes the original error through, and a
 * mapper that itself throws keeps its own error chained to the original
 * as `cause`. The raw `fetch()` escape hatch bypasses the mapper
 * entirely.
 *
 * @template T - Optional override for the resolved data type
 * @template O - The fetchable configuration type (inferred)
 * @param o - The fetchable configuration with a data reader
 * @returns A Promise resolving to the parsed data
 * @throws {HTTPError} When the response status is not ok
 * @throws {NetworkError} When fetch itself fails at the network level
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
  try {
    const res = await fetch(o);
    // Opaque responses (no-cors) report status 0 / ok:false without being
    // errors — matching ky 2.0 semantics, they do not throw; any failure
    // to read the opaque body surfaces naturally from the reader instead.
    if (!res.ok && res.type !== 'opaque') {
      const err = new HTTPError(res, bestEffortRequest(o));
      // Attach the parsed error body when a data reader middleware stored it.
      err.data = hasData(res) ? getData(res) : undefined;
      throw err;
    }
    return getData<ReaderData<O>>(res) as ResolveData<T, O>;
  } catch (e) {
    const mapper = o[mapErrorSymbol];
    if (!mapper) throw e;
    // Only HTTPError can contribute response/request context; every other
    // error type (network, timeout, validation, user middleware) gets {}.
    const ctx: MapErrorContext =
      e instanceof HTTPError
        ? { response: e.response, request: e.request }
        : {};
    let mapped: unknown;
    try {
      mapped = await mapper(e, ctx);
    } catch (mapperError) {
      // A failing mapper must never swallow the original error: its own
      // throw surfaces, chained to the original (see wrapMapperError).
      throw wrapMapperError(mapperError, e);
    }
    // Returning undefined passes the original error through — a partial
    // mapper (branching on error type) can leave branches unmapped without
    // accidentally rejecting with undefined.
    if (mapped === undefined) throw e;
    throw mapped;
  }
}

/**
 * Chains a `mapError` mapper's own failure to the original error so
 * neither is lost. An `Error` without a `cause` keeps its identity and
 * gains the original error as `cause`; anything else (a non-Error thrown
 * value, or an Error already carrying a cause) is wrapped in a
 * descriptive `Error` whose `cause` holds both values.
 */
function wrapMapperError(mapperError: unknown, original: unknown): unknown {
  if (
    mapperError instanceof Error &&
    (mapperError as { cause?: unknown }).cause === undefined
  ) {
    mapperError.cause = original;
    return mapperError;
  }
  return new Error('fetch-fun: the mapError mapper itself threw', {
    cause: { mapperError, original },
  });
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
 * @throws {NetworkError} When fetch itself fails at the network level
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
