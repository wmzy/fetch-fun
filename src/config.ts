import { createRetry, normalizeMiddleware } from './middleware';
import type { RetryOptions } from './middleware';
import type {
  AppendQueryType,
  Fetchable,
  Method,
  MiddlewareFn,
  MiddlewareEntry,
  MiddlewareInput,
  MW,
  InferMiddlewareName,
  MapMiddlewares,
  Options,
  QueryType,
  SchemaOutput,
  SetQueryType,
  StandardSchema,
  TypedURLSearchParams,
} from './types';
import { readDataSymbol, validateSymbol } from './constants';
import { getData, hasData, setData } from './util';
import { ValidationError } from './errors';

/**
 * Sets the HTTP method for the request.
 *
 * @param o - The options object to modify
 * @param method - The HTTP method ('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', etc.)
 * @returns A new options object with the method set
 *
 * @example
 * ```ts
 * client.pipe(method, 'POST')
 * ```
 */
export function method<T extends Options, M extends Method>(
  o: T,
  method: M
): Omit<T, 'method'> & { method: M } {
  return {
    ...o,
    method,
  };
}

/**
 * Sets the URL path for the request.
 *
 * @param o - The options object to modify
 * @param url - The URL path (will be combined with baseUrl if present)
 * @returns A new options object with the URL set
 *
 * @example
 * ```ts
 * client.pipe(url, '/api/users')
 * ```
 */
export function url<T extends Options, U extends string>(
  o: T,
  url: U
): Omit<T, 'url'> & { url: U } {
  return {
    ...o,
    url,
  };
}

/**
 * Appends a path segment to the existing URL.
 *
 * @param o - The options object with an existing URL
 * @param path - The path segment to append
 * @returns A new options object with the appended URL
 *
 * @example
 * ```ts
 * // If url is '/api', result will be '/api/users'
 * client.pipe(url, '/api').pipe(appendUrl, '/users')
 * ```
 */
export function appendUrl<
  const T extends Options & { url: string },
  U extends string
>(o: T, path: U): Omit<T, 'url'> & { url: `${T['url']}${U}` } {
  return url(o, `${o.url}${path}`);
}

/**
 * Sets the base URL prefix for all requests.
 *
 * At fetch time the final URL is built by joining `baseUrl` and `url` with
 * slash normalization (trailing slashes on the base and leading slashes on
 * the path collapse to a single `/`); an absolute `url` bypasses the base.
 * A `baseUrl` carrying its own query string is not supported — use the
 * `query`/`mergeQuery` config functions instead.
 *
 * @param o - The options object to modify
 * @param baseUrl - The base URL (e.g., 'https://api.example.com')
 * @returns A new options object with the base URL set
 *
 * @example
 * ```ts
 * client.pipe(baseUrl, 'https://api.example.com')
 * ```
 */
export function baseUrl<T extends Options, U extends string>(
  o: T,
  baseUrl: U
): T & { baseUrl: U } {
  return {
    ...o,
    baseUrl,
  };
}

/**
 * Shared implementation of the method sugar helpers: sets the HTTP method,
 * replaces the URL when a path is given, and sets a JSON body when one is
 * given.
 */
function applyMethod<M extends Method>(
  o: Options,
  m: M,
  path: string | undefined,
  json: unknown
): Omit<Options, 'method'> & { method: M } {
  const withUrl = path === undefined ? o : url(o, path);
  const withBody = json === undefined ? withUrl : jsonBody(withUrl, json);
  return method(withBody, m);
}

/**
 * Restores the `url` property for {@link MethodSugar} when no path was
 * given: the incoming `url` is preserved, or stays optional when absent.
 */
type KeepUrl<T> = T extends { url: infer U extends string }
  ? { url: U }
  : { url?: string };

/**
 * Return type of the method sugar helpers ({@link get}, {@link post}, …):
 * the method is fixed to `M`, and `url` becomes the sugar-provided `path`
 * when one was given, otherwise the incoming `url` is kept as-is.
 */
type MethodSugar<
  T extends Options,
  U extends string | undefined,
  M extends Method,
> = Omit<T, 'url' | 'method'> & { method: M } & (U extends string
  ? { url: U }
  : KeepUrl<T>);

/**
 * Sets the HTTP method to GET, optionally setting the URL path in one step.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(get, '/users')
 * ```
 */
export function get<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'GET'> {
  return applyMethod(o, 'GET', path, json) as MethodSugar<T, U, 'GET'>;
}

/**
 * Sets the HTTP method to POST, optionally setting the URL path and a JSON
 * body in one step.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(post, '/users', { name: 'Alice' })
 * ```
 */
export function post<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'POST'> {
  return applyMethod(o, 'POST', path, json) as MethodSugar<T, U, 'POST'>;
}

/**
 * Sets the HTTP method to PUT, optionally setting the URL path and a JSON
 * body in one step.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(put, '/users/1', { name: 'Alice' })
 * ```
 */
export function put<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'PUT'> {
  return applyMethod(o, 'PUT', path, json) as MethodSugar<T, U, 'PUT'>;
}

/**
 * Sets the HTTP method to PATCH, optionally setting the URL path and a JSON
 * body in one step.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(patch, '/users/1', { name: 'Alice' })
 * ```
 */
export function patch<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'PATCH'> {
  return applyMethod(o, 'PATCH', path, json) as MethodSugar<T, U, 'PATCH'>;
}

/**
 * Sets the HTTP method to DELETE, optionally setting the URL path and a JSON
 * body in one step.
 *
 * Named `del` rather than `delete` because `delete` is a reserved word and
 * cannot be used as a function name.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(del, '/users/1')
 * ```
 */
export function del<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'DELETE'> {
  return applyMethod(o, 'DELETE', path, json) as MethodSugar<T, U, 'DELETE'>;
}

/**
 * Sets the HTTP method to HEAD, optionally setting the URL path in one step.
 *
 * When `json` is provided, the body is set to its JSON string and
 * Content-Type to application/json; when omitted, the body is untouched.
 *
 * @param o - The options object to modify
 * @param path - The URL path; when omitted, the existing `url` is kept
 * @param json - The JSON request body (not to be confused with the
 * response-parsing {@link json})
 * @returns A new options object with the method (and optionally url/body) set
 *
 * @example
 * ```ts
 * client.pipe(head, '/users')
 * ```
 */
export function head<
  T extends Options,
  U extends string | undefined = undefined,
>(o: T, path?: U, json?: unknown): MethodSugar<T, U, 'HEAD'> {
  return applyMethod(o, 'HEAD', path, json) as MethodSugar<T, U, 'HEAD'>;
}

/**
 * Input accepted by {@link query} and {@link mergeQuery}: a query string,
 * a `URLSearchParams` instance, an array of key/value tuples, or a plain
 * object. Non-string values (numbers, booleans) are serialized via
 * `String(value)` before reaching `URLSearchParams`.
 */
export type QueryInput =
  | string
  | URLSearchParams
  | readonly (readonly [string, string | number | boolean])[]
  | readonly string[][]
  | Record<string, string | number | boolean>;

/**
 * Normalizes a {@link QueryInput} into a `URLSearchParams`,
 * stringifying non-string values along the way.
 */
function toSearchParams(params: QueryInput): URLSearchParams {
  if (typeof params === 'string' || params instanceof URLSearchParams) {
    return new URLSearchParams(params);
  }
  if (Array.isArray(params)) {
    return new URLSearchParams(params.map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  );
}

/**
 * Sets query parameters, replacing any existing searchParams.
 *
 * Accepts a string, URLSearchParams, an array of key/value tuples, or a
 * plain object. Numbers and booleans are serialized via `String(value)`.
 * For advanced serialization (nested objects, brackets), use your
 * preferred library (e.g., `qs`, `query-string`) and pass the resulting
 * string. The searchParams will be appended to the URL in `toFetchParams`.
 *
 * @param o - The options object to modify
 * @param params - The query input (string, URLSearchParams, tuples, or object)
 * @returns A new options object with searchParams set
 *
 * @example
 * ```ts
 * // With string
 * client.pipe(url, '/users').pipe(query, 'page=1&limit=10')
 *
 * // With URLSearchParams
 * client.pipe(url, '/users').pipe(query, new URLSearchParams({ page: '1' }))
 *
 * // With object - numbers and booleans are stringified
 * client.pipe(url, '/users').pipe(query, { page: 1, active: true })
 *
 * // With qs library for custom serialization
 * import qs from 'qs';
 * client.pipe(url, '/users').pipe(query, qs.stringify({ tags: ['a', 'b'] }))
 * ```
 */
export function query<T extends Options>(
  o: T,
  params: QueryInput
): Omit<T, 'searchParams'> & {
  searchParams: TypedURLSearchParams;
} {
  return {
    ...o,
    searchParams: toSearchParams(params) as TypedURLSearchParams,
  };
}

/**
 * Merges query parameters with existing searchParams.
 *
 * Accepts any {@link QueryInput}. Non-string values are stringified.
 * The searchParams will be appended to the URL in `toFetchParams`.
 *
 * @param o - The options object to modify
 * @param params - The query parameters to merge (string, URLSearchParams, tuples, object)
 * @returns A new options object with merged searchParams
 *
 * @example
 * ```ts
 * // Merge with existing query
 * client.pipe(url, '/users').pipe(query, 'page=1').pipe(mergeQuery, 'limit=10')
 * // => searchParams: page=1&limit=10
 *
 * // With URLSearchParams
 * client.pipe(url, '/users').pipe(mergeQuery, new URLSearchParams({ limit: '10' }))
 *
 * // With object
 * client.pipe(url, '/users').pipe(mergeQuery, { page: 1, limit: 10 })
 * ```
 */
export function mergeQuery<T extends Options>(
  o: T,
  params: QueryInput
): T & { searchParams: TypedURLSearchParams } {
  return {
    ...o,
    searchParams: new URLSearchParams([
      ...(o.searchParams || []),
      ...toSearchParams(params),
    ]) as TypedURLSearchParams,
  };
}

/**
 * Sets a single query parameter, replacing any existing value for that key.
 * Provides type-level tracking of parameter names and values.
 * Non-string values are serialized via `String(value)` and tracked as
 * their stringified literal (e.g., `1` tracks as `'1'`).
 *
 * @param o - The options object to modify
 * @param name - The parameter name
 * @param value - The parameter value
 * @returns A new options object with the parameter set and type tracked
 *
 * @example
 * ```ts
 * // Set a single parameter - TypeScript tracks { page: '1' }
 * client.pipe(url, '/users').pipe(querySet, 'page', '1')
 *
 * // Numbers and booleans are stringified - tracks { page: '1', active: 'true' }
 * client.pipe(querySet, 'page', 1).pipe(querySet, 'active', true)
 *
 * // Replace existing value - TypeScript tracks { page: '2' }
 * client.pipe(querySet, 'page', '1').pipe(querySet, 'page', '2')
 * ```
 */
type InferQueryType<T> = T extends {
  searchParams?: TypedURLSearchParams<infer Q>;
}
  ? Q
  : QueryType;

export function querySet<
  T extends Options,
  K extends string,
  V extends string | number | boolean
>(
  o: T,
  name: K,
  value: V
): Omit<T, 'searchParams'> & {
  searchParams: TypedURLSearchParams<SetQueryType<InferQueryType<T>, K, V>>;
} {
  const searchParams = new URLSearchParams(o.searchParams);
  searchParams.set(name, String(value));
  return {
    ...o,
    searchParams,
  } as any;
}

/**
 * Appends a single query parameter, allowing duplicate keys.
 * Provides type-level tracking - repeated keys become arrays.
 * Non-string values are serialized via `String(value)` and tracked as
 * their stringified literal (e.g., `2` tracks as `'2'`).
 *
 * Unlike `querySet`, this does not replace existing values for the same key.
 *
 * @param o - The options object to modify
 * @param name - The parameter name
 * @param value - The parameter value
 * @returns A new options object with the parameter appended and type tracked
 *
 * @example
 * ```ts
 * // Append a parameter - TypeScript tracks { tag: 'javascript' }
 * client.pipe(url, '/posts').pipe(queryAppend, 'tag', 'javascript')
 *
 * // Append duplicate keys - TypeScript tracks { tag: ['a', 'b'] }
 * client.pipe(queryAppend, 'tag', 'a').pipe(queryAppend, 'tag', 'b')
 *
 * // Mix with other params - TypeScript tracks { page: '1', tag: ['a', '2'] }
 * client
 *   .pipe(querySet, 'page', '1')
 *   .pipe(queryAppend, 'tag', 'a')
 *   .pipe(queryAppend, 'tag', 2)
 * ```
 */
export function queryAppend<
  T extends Options,
  K extends string,
  V extends string | number | boolean
>(
  o: T,
  name: K,
  value: V
): Omit<T, 'searchParams'> & {
  searchParams: TypedURLSearchParams<AppendQueryType<InferQueryType<T>, K, V>>;
} {
  return {
    ...o,
    searchParams: new URLSearchParams([
      ...(o.searchParams || []),
      [name, String(value)],
    ]),
  } as any;
}

/**
 * Sets the AbortSignal for request cancellation.
 *
 * @param o - The options object to modify
 * @param signal - The AbortSignal to use for cancellation
 * @returns A new options object with the signal set
 *
 * @example
 * ```ts
 * // With AbortController
 * const controller = new AbortController();
 * client.pipe(signal, controller.signal)
 *
 * // With timeout
 * client.pipe(signal, AbortSignal.timeout(5000))
 * ```
 */
export function signal<T extends Options>(
  o: T,
  signal: AbortSignal
): T & { signal: AbortSignal } {
  return {
    ...o,
    signal,
  };
}

/**
 * Sets a per-request timeout budget.
 *
 * The value is stored as `timeoutMs` on the options object; no timer starts
 * until the request actually executes (`fetch` creates a fresh
 * `AbortSignal.timeout(ms)` per attempt). Piping `timeout` is therefore lazy
 * and side-effect free: reusing a client later still gets a full budget, and
 * a later `timeout` pipe overwrites an earlier value. An existing `signal`
 * is honored — both are combined with `AbortSignal.any`.
 *
 * Requires `AbortSignal.any` (Node.js >= 20.3.0 or a modern browser).
 *
 * @param o - The options object to modify
 * @param ms - The timeout budget in milliseconds
 * @returns A new options object with `timeoutMs` set
 *
 * @example
 * ```ts
 * // Each request gets 5 seconds, counted from when it starts
 * client.pipe(timeout, 5000)
 * ```
 */
export function timeout<T extends Options>(
  o: T,
  ms: number
): T & { timeoutMs: number } {
  return {
    ...o,
    timeoutMs: ms,
  };
}

/**
 * Input accepted by {@link headers}: a plain record, a `Headers` instance,
 * or an array of `[name, value]` tuples. `Headers` instances and tuple
 * arrays are normalized into a plain record for storage.
 */
export type HeadersInput =
  | Record<string, string>
  | Headers
  | [string, string][];

/**
 * Normalizes a {@link HeadersInput} into the plain record form stored on
 * the options object. Plain records pass through unchanged (preserving
 * header-name casing and key order); `Headers` instances and tuple arrays
 * are expanded via `Object.fromEntries`.
 */
function toHeadersRecord(h: HeadersInput): Record<string, string> {
  if (h instanceof Headers || Array.isArray(h)) {
    return Object.fromEntries(h);
  }
  return h;
}

/**
 * Sets all HTTP headers, replacing any existing headers.
 *
 * Accepts a plain record, a `Headers` instance, or an array of
 * `[name, value]` tuples. Non-record forms are normalized into a plain
 * `Record<string, string>` before being stored.
 *
 * @param o - The options object to modify
 * @param headers - The headers (record, `Headers`, or tuple array)
 * @returns A new options object with the headers set
 *
 * @example
 * ```ts
 * client.pipe(headers, {
 *   'Content-Type': 'application/json',
 *   'Authorization': 'Bearer token'
 * })
 *
 * // Headers instance or tuple array are accepted too
 * client.pipe(headers, new Headers({ 'Content-Type': 'application/json' }))
 * client.pipe(headers, [['Content-Type', 'application/json']])
 * ```
 */
export function headers<T extends Options, H extends Record<string, string>>(
  o: T,
  headers: H | Headers | [string, string][]
): Omit<T, 'headers'> & {
  headers: H;
} {
  return {
    ...o,
    headers: toHeadersRecord(headers) as H,
  };
}

/**
 * Sets or adds a single HTTP header.
 *
 * @param o - The options object to modify
 * @param name - The header name
 * @param value - The header value
 * @returns A new options object with the header added
 *
 * @example
 * ```ts
 * client.pipe(header, 'Authorization', 'Bearer token')
 * ```
 */
export function header<T extends Options, K extends string, V extends string>(
  o: T,
  name: K,
  value: V
): Omit<T, 'headers'> & {
  headers: Record<K, V>;
};
export function header<
  H extends Record<string, string>,
  T extends Options & { headers: H },
  K extends string,
  V extends string
>(
  o: T,
  name: K,
  value: V
): Omit<T, 'headers'> & {
  headers: H & Record<K, V>;
} {
  // Defensive: `headers()` normalizes `Headers` instances away, but a user
  // may still set one directly on the options object. Spreading a `Headers`
  // instance yields an empty object, so expand it first to avoid silently
  // dropping the existing headers.
  const base =
    o.headers instanceof Headers
      ? (Object.fromEntries(o.headers) as H)
      : o.headers;
  return {
    ...o,
    headers: {
      ...base,
      [name]: value,
    },
  };
}

/**
 * Sets the Accept header to specify expected response media type.
 *
 * @param o - The options object to modify
 * @param mime - The MIME type to accept
 * @returns A new options object with the Accept header set
 *
 * @example
 * ```ts
 * client.pipe(accept, 'application/json')
 * ```
 */
export function accept<T extends Options>(o: T, mime: string) {
  return header(o, 'Accept', mime);
}

/**
 * Sets the Authorization header.
 *
 * @param o - The options object to modify
 * @param type - The authentication type ('Basic', 'Bearer', 'Digest', or custom)
 * @param credentials - The credentials string
 * @returns A new options object with the Authorization header set
 *
 * @example
 * ```ts
 * // Bearer token
 * client.pipe(auth, 'Bearer', 'your-jwt-token')
 *
 * // Basic auth
 * client.pipe(auth, 'Basic', btoa('username:password'))
 * ```
 */
export function auth<T extends Options>(
  o: T,
  type: 'Basic' | 'Bearer' | 'Digest' | string,
  credentials: string
) {
  return header(o, 'Authorization', `${type} ${credentials}`);
}

/**
 * Sets the Content-Type header.
 *
 * @param o - The options object to modify
 * @param type - The content MIME type
 * @returns A new options object with the Content-Type header set
 *
 * @example
 * ```ts
 * client.pipe(contentType, 'application/json')
 * ```
 */
export function contentType<T extends Options>(o: T, type: string) {
  return header(o, 'Content-Type', type);
}

/**
 * Sets the request body.
 *
 * Accepts any `BodyInit` value (string, `FormData`, `Blob`,
 * `URLSearchParams`, `ArrayBuffer`, streams, ...) or `null`, matching the
 * native `fetch` `RequestInit.body` contract. Use {@link jsonBody} to
 * serialize a value as JSON and set the Content-Type header.
 *
 * @param o - The options object to modify
 * @param data - The body content
 * @returns A new options object with the body set
 *
 * @example
 * ```ts
 * client.pipe(body, 'raw text content')
 *
 * // Non-string bodies pass through as-is
 * client.pipe(body, new FormData())
 * client.pipe(body, new Blob(['binary']))
 * ```
 */
export function body<T extends Options>(o: T, data: BodyInit | null) {
  return {
    ...o,
    body: data,
  };
}

/**
 * Sets the request body as JSON and sets Content-Type to application/json.
 *
 * @param o - The options object to modify
 * @param data - The data to serialize as JSON
 * @returns A new options object with the JSON body and Content-Type set
 *
 * @example
 * ```ts
 * client.pipe(jsonBody, { name: 'John', age: 30 })
 * ```
 */
export function jsonBody<T extends Options>(o: T, data: unknown) {
  return body(contentType(o, 'application/json'), JSON.stringify(data));
}

/**
 * Sets the middleware array, replacing any existing middlewares.
 *
 * @param o - The options object to modify
 * @param newMiddlewares - Array of middleware inputs (functions or configs)
 * @returns A new options object with the middlewares set
 *
 * @example
 * ```ts
 * client.pipe(middlewares, [loggingMiddleware, authMiddleware])
 * ```
 */
export function middlewares<
  T extends Options,
  const M extends readonly MiddlewareInput[],
>(
  o: T,
  newMiddlewares: M
): Omit<T, 'middlewares'> & {
  middlewares: MapMiddlewares<M>;
} {
  return {
    ...o,
    middlewares: newMiddlewares.map(normalizeMiddleware),
  } as any;
}

/**
 * Infer existing middlewares type from Options as a tuple.
 */
type InferMiddlewares<T> = T extends { middlewares: infer M extends unknown[] }
  ? M
  : [];

/**
 * Adds a middleware to the middleware chain.
 *
 * Accepts either a simple middleware function or a configuration object
 * with positioning information for the onion model.
 *
 * @param o - The options object to modify
 * @param middleware - The middleware function or configuration object
 * @returns A new options object with the middleware added
 *
 * @example
 * ```ts
 * // Simple middleware function
 * const loggingMiddleware: MiddlewareFn = (f, instance) =>
 *   (...params) => {
 *     console.log('Request:', params);
 *     return f(...params);
 *   };
 * client.pipe(use, loggingMiddleware)
 *
 * // Middleware with positioning (onion model)
 * client.pipe(use, {
 *   name: 'builtin:timeout',
 *   outer: 'builtin:retry',  // timeout wraps retry
 *   middleware: createTimeout(5000),
 * })
 *
 * // Using built-in middleware factories
 * import { builtins } from 'fetch-fun';
 * client.pipe(use, builtins.retry(3))
 * client.pipe(use, builtins.timeout(5000))
 * ```
 */
export function use<T extends Options, const M extends MiddlewareInput>(
  o: T,
  middleware: M
): Omit<T, 'middlewares'> & {
  middlewares: [...InferMiddlewares<T>, MW<InferMiddlewareName<M>>];
} {
  return {
    ...o,
    middlewares: [...(o.middlewares || []), normalizeMiddleware(middleware)],
  } as any;
}

/**
 * Adds retry functionality with a status/method/error-aware policy.
 *
 * Retries failed requests up to `maxRetries` times, but only when it is
 * safe and sensible to do so:
 *
 * - Only requests whose method is (by default) idempotent — `GET`, `HEAD`,
 *   `OPTIONS`, `TRACE`, `PUT`, `DELETE` — are retried. Non-idempotent
 *   methods like `POST`/`PATCH` never retry, to avoid duplicating side
 *   effects.
 * - Resolved responses retry only on transient statuses (default:
 *   `408, 425, 429, 500, 502, 503, 504`); a 404 resolves as-is instead of
 *   burning retries.
 * - Rejected attempts retry on network errors, timeouts, and unknown
 *   errors; `HTTPError` retries only for retryable statuses, while
 *   `ValidationError` and `asNotRetryError`-wrapped errors never retry.
 * - Waits use exponential backoff with jitter (initial: 1s, max: 10s,
 *   multiplier: 2), overridden by a parseable non-past `Retry-After`
 *   header when `respectRetryAfter` is true (default).
 *
 * **Behavior change from the previous unconditional retry:** the old
 * implementation retried every failure up to `maxRetries` times regardless
 * of method, status, or error type.
 *
 * @param o - The options object to modify
 * @param maxRetries - Maximum number of retry attempts (the initial attempt
 * is not counted)
 * @param opts - Policy overrides: `statuses`, `methods`, `respectRetryAfter`,
 * and `delay` backoff tuning (see `RetryOptions`)
 * @returns A new options object with retry middleware added
 *
 * @example
 * ```ts
 * // Retry idempotent requests up to 3 times on transient failures
 * client.pipe(retry, 3)
 *
 * // Custom policy: retry only 503, also for POST, 5s initial delay
 * client.pipe(retry, 3, {
 *   statuses: [503],
 *   methods: ['GET', 'POST'],
 *   delay: { initial: 5000 },
 * })
 * ```
 */
export function retry<T extends Options>(
  o: T,
  maxRetries: number,
  opts?: RetryOptions
) {
  return use(o, createRetry(maxRetries, opts));
}

/**
 * Adds a response mapper middleware.
 *
 * Allows transforming or inspecting the response after fetch completes.
 *
 * @param o - The options object to modify
 * @param mapper - Function to transform the response
 * @returns A new options object with the response mapper middleware added
 *
 * @example
 * ```ts
 * // Log response status
 * client.pipe(mapResponse, (res) => {
 *   console.log('Status:', res.status);
 *   return res;
 * })
 * ```
 */
export function mapResponse<T extends Options>(
  o: T,
  mapper: (res: Response, options: Fetchable) => Response | Promise<Response>
) {
  const mw: MiddlewareFn =
    (f, options) =>
    (...params: Parameters<typeof f>) =>
      f(...params).then((res) => mapper(res, options));
  return use(o, mw);
}

/**
 * Adds error checking middleware.
 *
 * Allows inspecting the response and throwing errors based on response status or content.
 *
 * @param o - The options object to modify
 * @param check - Function to check for errors (throw to indicate error)
 * @returns A new options object with the error checking middleware added
 *
 * @example
 * ```ts
 * // Throw on non-2xx status
 * client.pipe(checkError, (res) => {
 *   if (!res.ok) {
 *     throw new Error(`HTTP ${res.status}: ${res.statusText}`);
 *   }
 * })
 * ```
 */
export function checkError<T extends Options>(
  o: T,
  check: (res: Response) => void | Promise<void>
) {
  return mapResponse(o, async (res) => {
    await check(res);
    return res;
  });
}

/**
 * Adds a response data reader middleware.
 *
 * Reads and stores response data using the provided reader function.
 * The data can be retrieved later using `getData()`.
 *
 * @param o - The options object to modify
 * @param reader - Function to read data from the response
 * @returns A new options object with the data reader middleware added
 *
 * @example
 * ```ts
 * // Custom XML parser
 * client.pipe(data, async (res) => {
 *   const text = await res.text();
 *   return parseXML(text);
 * })
 * ```
 */
export function data<T extends Options, R>(
  o: T,
  reader: (res: Response) => R
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => R;
} {
  const options = {
    ...o,
    [readDataSymbol]: reader,
  };
  return mapResponse(options, async (res, finalOptions) => {
    if (hasData(res)) return res;

    const currentReader = (finalOptions as any)[readDataSymbol] as (
      res: Response
    ) => unknown;
    setData(res, await currentReader(res));
    await validateData(res, finalOptions);
    return res;
  }) as unknown as T & {
    middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
    [readDataSymbol]: (res: Response) => R;
  };
}

/**
 * Adds JSON response parsing middleware.
 *
 * Automatically parses the response body as JSON. Pass a custom
 * `parseJson` function to control parsing (e.g. revive `Date` fields);
 * the function receives the raw response text and its return type
 * becomes the inferred data type. Without a parser the behavior is
 * `JSON.parse` of the response text.
 *
 * **Breaking change:** this function no longer sets a `Content-Type:
 * application/json` request header — it only configures response parsing,
 * so a GET request with `json()` no longer sends a meaningless header.
 * To send JSON, use {@link jsonBody} (which sets both body and
 * `Content-Type: application/json`), or set request headers explicitly
 * with {@link contentType} / {@link header}.
 *
 * @param o - The options object to modify
 * @param parseJson - Optional custom parser for the raw response text
 * @returns A new options object with JSON parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/data').pipe(json).pipe(fetch);
 * const data = getData(response);
 * ```
 *
 * @example
 * ```ts
 * // Revive ISO date strings into Date instances
 * const response = await client
 *   .pipe(url, '/api/event')
 *   .pipe(json, (raw) => JSON.parse(raw, (k, v) => (k === 'at' ? new Date(v) : v)))
 *   .pipe(fetch);
 * ```
 */
export function json<T extends Options, D = unknown>(
  o: T,
  parseJson: (raw: string) => D = (raw) => JSON.parse(raw) as D
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<D>;
} {
  return data(o, async (res) => parseJson(await res.text()));
}

/**
 * Adds text response parsing middleware.
 *
 * Automatically reads the response body as text.
 *
 * @param o - The options object to modify
 * @returns A new options object with text parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/text').pipe(text).pipe(fetch);
 * const content = getData(response);
 * ```
 */
export function text<T extends Options>(
  o: T
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<string>;
} {
  return data(o, (res) => res.text());
}

/**
 * Adds blob response parsing middleware.
 *
 * Automatically reads the response body as a Blob.
 *
 * @param o - The options object to modify
 * @returns A new options object with blob parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/file').pipe(blob).pipe(fetch);
 * const file = getData<Blob>(response);
 * ```
 */
export function blob<T extends Options>(
  o: T
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<Blob>;
} {
  return data(o, (res) => res.blob());
}

/**
 * Adds ArrayBuffer response parsing middleware.
 *
 * Automatically reads the response body as an ArrayBuffer.
 *
 * @param o - The options object to modify
 * @returns A new options object with ArrayBuffer parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/file').pipe(arrayBuffer).pipe(fetch);
 * const buffer = getData<ArrayBuffer>(response);
 * ```
 */
export function arrayBuffer<T extends Options>(
  o: T
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<ArrayBuffer>;
} {
  return data(o, (res) => res.arrayBuffer());
}

/**
 * Adds FormData response parsing middleware.
 *
 * Automatically reads the response body as FormData (e.g. a
 * `multipart/form-data` response).
 *
 * @param o - The options object to modify
 * @returns A new options object with FormData parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/upload').pipe(formData).pipe(fetch);
 * const fields = getData<FormData>(response);
 * ```
 */
export function formData<T extends Options>(
  o: T
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<FormData>;
} {
  return data(o, (res) => res.formData());
}

/**
 * Checks whether a value duck-types as a Standard Schema v1 schema:
 * a `~standard` property whose `version` is 1 and whose `validate`
 * is a function.
 */
function isStandardSchema(v: unknown): v is StandardSchema {
  return (
    typeof v === 'object' &&
    v !== null &&
    '~standard' in v &&
    typeof (v as StandardSchema)['~standard'] === 'object' &&
    (v as StandardSchema)['~standard'] !== null &&
    (v as StandardSchema)['~standard'].version === 1 &&
    typeof (v as StandardSchema)['~standard'].validate === 'function'
  );
}

/**
 * Attaches a Standard Schema v1 schema to the options so the parsed
 * response data is validated after the data reader middleware runs —
 * regardless of pipe order.
 *
 * On success, a transformed/defaulted `result.value` replaces the stored
 * data. On failure, `fetchData`/`fetchJSON` reject with a
 * {@link ValidationError} carrying the schema issues. Validation is
 * skipped for non-2xx responses so {@link HTTPError} semantics stay
 * intact.
 *
 * Works with any Standard Schema v1 library (Zod, Valibot, ArkType, ...)
 * via duck typing — zero runtime dependencies.
 *
 * @param o - The options object to modify
 * @param schema - A Standard Schema v1 schema object
 * @returns A new options object with the schema attached
 * @throws {TypeError} When `schema` is not a Standard Schema v1 object
 *
 * @example
 * ```ts
 * const user = await client
 *   .pipe(url, '/users/1')
 *   .pipe(validate, UserSchema) // Zod/Valibot/ArkType schema
 *   .pipe(fetchJSON);
 * ```
 */
export function validate<T extends Options, S extends StandardSchema>(
  o: T,
  schema: S
): Omit<T, typeof readDataSymbol> & {
  [readDataSymbol]: (res: Response) => Promise<SchemaOutput<S>>;
} {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      "validate() expects a Standard Schema v1 object: one with a '~standard' property of the form { version: 1, validate(value) }, as provided by Zod, Valibot, ArkType, etc."
    );
  }
  return { ...o, [validateSymbol]: schema } as unknown as Omit<
    T,
    typeof readDataSymbol
  > & {
    [readDataSymbol]: (res: Response) => Promise<SchemaOutput<S>>;
  };
}

/**
 * Runs the schema attached via {@link validate} against the parsed
 * response data, replacing it with the validated output on success.
 *
 * Skipped for non-2xx responses (`!res.ok`) so `fetchData` keeps throwing
 * {@link HTTPError} and the raw `fetch()` escape hatch stays non-throwing.
 */
async function validateData(
  res: Response,
  finalOptions: Fetchable
): Promise<void> {
  if (!res.ok) return;
  const schema = (finalOptions as any)[validateSymbol] as
    | StandardSchema
    | undefined;
  if (!schema) return;

  const data = getData(res);
  const result = await schema['~standard'].validate(data);
  if (result.issues && result.issues.length > 0) {
    throw new ValidationError(result.issues, data);
  }
  if (result.value !== undefined) {
    setData(res, result.value);
  }
}
