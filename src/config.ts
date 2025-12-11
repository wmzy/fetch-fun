import { createRetry } from './middleware';
import type { Fetchable, Method, Middleware, Options } from './types';
import { dataSymbol, readDataSymbol } from './constants';

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
 * Sets all HTTP headers, replacing any existing headers.
 *
 * @param o - The options object to modify
 * @param headers - The headers object
 * @returns A new options object with the headers set
 *
 * @example
 * ```ts
 * client.pipe(headers, {
 *   'Content-Type': 'application/json',
 *   'Authorization': 'Bearer token'
 * })
 * ```
 */
export function headers<T extends Options, H extends Record<string, string>>(
  o: T,
  headers: H
): Omit<T, 'headers'> & {
  headers: H;
} {
  return {
    ...o,
    headers,
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
  return {
    ...o,
    headers: {
      ...o.headers,
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
 * Sets the request body as a string.
 *
 * @param o - The options object to modify
 * @param data - The body content as a string
 * @returns A new options object with the body set
 *
 * @example
 * ```ts
 * client.pipe(body, 'raw text content')
 * ```
 */
export function body<T extends Options>(o: T, data: string) {
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
 * @param newMiddlewares - Array of middleware functions
 * @returns A new options object with the middlewares set
 *
 * @example
 * ```ts
 * client.pipe(middlewares, [loggingMiddleware, authMiddleware])
 * ```
 */
export function middlewares<T extends Options>(
  o: T,
  newMiddlewares: Middleware[]
): T & {
  middlewares: Middleware[];
} {
  return {
    ...o,
    middlewares: newMiddlewares,
  };
}

/**
 * Adds a middleware function to the middleware chain.
 *
 * @param o - The options object to modify
 * @param middleware - The middleware function to add
 * @returns A new options object with the middleware added
 *
 * @example
 * ```ts
 * const loggingMiddleware: Middleware = (f, instance) =>
 *   (...params) => {
 *     console.log('Request:', params);
 *     return f(...params);
 *   };
 *
 * client.pipe(use, loggingMiddleware)
 * ```
 */
export function use<T extends Options>(
  o: T,
  middleware: Middleware
): T & {
  middlewares: Middleware[];
} {
  return {
    ...o,
    middlewares: [...(o.middlewares || []), middleware],
  };
}

/**
 * Adds retry functionality with exponential backoff.
 *
 * Retries failed requests up to the specified number of times.
 * Uses exponential backoff with jitter (initial: 1s, max: 10s, multiplier: 2).
 *
 * @param o - The options object to modify
 * @param maxRetries - Maximum number of retry attempts
 * @returns A new options object with retry middleware added
 *
 * @example
 * ```ts
 * // Retry up to 3 times on failure
 * client.pipe(retry, 3)
 * ```
 */
export function retry<T extends Options>(o: T, maxRetries: number) {
  return use(o, createRetry(maxRetries));
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
  return use(
    o,
    (f, options) =>
      (...params: Parameters<typeof f>) =>
        f(...params).then((res) => mapper(res, options))
  );
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
export function data<T extends Options>(
  o: T,
  reader: (res: Response) => unknown
) {
  const options = {
    ...o,
    [readDataSymbol]: reader,
  };
  return mapResponse(options, async (res, finalOptions) => {
    if (dataSymbol in res) return res;

    const currentReader = (finalOptions as any)[readDataSymbol] as (
      res: Response
    ) => unknown;
    const data = await currentReader(res);
    return { ...res, [dataSymbol]: data };
  });
}

/**
 * Adds JSON response parsing middleware.
 *
 * Automatically parses the response body as JSON.
 *
 * @param o - The options object to modify
 * @returns A new options object with JSON parsing middleware added
 *
 * @example
 * ```ts
 * const response = await client.pipe(url, '/api/data').pipe(json).pipe(fetch);
 * const data = getData(response);
 * ```
 */
export function json<T extends Options>(o: T) {
  return data(o, (res) => res.json());
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
export function text<T extends Options>(o: T) {
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
export function blob<T extends Options>(o: T) {
  return data(o, (res) => res.blob());
}
