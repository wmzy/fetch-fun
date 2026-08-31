/**
 * OpenAPI-typed helpers — the `fetch-fun/openapi` sub-entry.
 *
 * Grafts openapi-typescript's generated `paths` type onto fetch-fun's
 * phantom types: after `const { typedUrl } = createOpenapi<paths>()`, the
 * path, method, request body and success-response shape of every pipe step
 * are compile-time constraints. Zero runtime of its own — each helper is a
 * thin wrapper over the main entry's config functions (`url`, `path`,
 * `method`, `jsonBody`, `json`), so the whole pipe stays in play:
 * middleware positioning, retry/timeout, Standard Schema `validate`,
 * injectable fetch.
 *
 * Unlike a dedicated OpenAPI client, nothing here cares where the `paths`
 * types came from: generated, hand-written, or adopted one endpoint at a
 * time. Types are a promise, not a guarantee — pair with `validate` when
 * the server's word needs checking.
 */
import type {
  MiddlewareEntry,
  Options,
  PlaceholderParams,
} from './types';

import { readDataSymbol } from './constants';
import { json, jsonBody, method, path, url } from './config';

/**
 * OpenAPI operation ids — the method keys under a path, excluding
 * openapi-typescript's generated `parameters` key.
 */
export type Op =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'options'
  | 'head'
  | 'patch'
  | 'trace';

/**
 * The path keys of a `paths` type as literal strings — including
 * `{param}` templates like `'/users/{id}'`, which openapi-typescript
 * emits verbatim as object keys.
 */
export type PathKey<paths> = Extract<keyof paths, string>;

/**
 * JSON body an operation accepts (`unknown` when the spec defines none).
 */
export type JsonBody<O> = O extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : unknown;

/**
 * JSON payload of an operation's success response — 200 first, 201 as
 * fallback (`unknown` when neither defines JSON content). Extend the chain
 * for other status codes.
 */
export type JsonOk<O> = O extends {
  responses: { 200: { content: { 'application/json': infer D } } };
}
  ? D
  : O extends {
      responses: { 201: { content: { 'application/json': infer D } } };
    }
    ? D
    : unknown;

/**
 * Binds one OpenAPI `paths` type to the typed pipe helpers. The type
 * argument is never inferred — pass it explicitly, once per spec:
 *
 * ```ts
 * import { createOpenapi } from 'fetch-fun/openapi';
 * import type { paths } from './api-types';
 *
 * const { typedUrl, typedPath, typedMethod, typedJsonBody, typedJson } =
 *   createOpenapi<paths>();
 * ```
 *
 * @returns Spec-bound variants of {@link url}, {@link path},
 * {@link method}, {@link jsonBody} and {@link json}
 */
export function createOpenapi<paths>() {
  /**
   * Path must be a real key of the generated `paths` type — a typo like
   * `'/user'` is a compile error, not a 404.
   */
  const typedUrl = <T extends Options, U extends PathKey<paths>>(
    o: T,
    path: U
  ): Omit<T, 'url'> & { url: U } => url(o, path);

  /**
   * Path template must be a real key of `paths`, and `params` must carry
   * exactly the template's placeholders: a missing key fails
   * `PlaceholderParams` at compile time (and `fillPath` at runtime), an
   * extra key fails excess-property checking on object literals. Values
   * are `encodeURIComponent`-ed, so a value can never inject path
   * separators or query syntax.
   *
   * `url` keeps the template's literal type so the method/body/reader
   * steps can keep constraining against `paths[U]` — only the runtime
   * value is the filled, encoded path.
   */
  const typedPath = <T extends Options, U extends PathKey<paths>>(
    o: T,
    template: U,
    params: PlaceholderParams<U>
  ): Omit<T, 'url'> & { url: U } =>
    path(o, template, params) as Omit<T, 'url'> & { url: U };

  /**
   * Method must be an operation that exists under the path — `'/tags' +
   * 'post'` or the generated `parameters` key both fail to compile. The
   * stored method is the uppercase form, matched by the readers below.
   */
  const typedMethod = <
    T extends Options,
    U extends PathKey<paths>,
    M extends keyof paths[U] & Op,
  >(
    o: T & { url: U },
    m: M
  ) => method<T & { url: U }, Uppercase<M>>(o, m.toUpperCase() as Uppercase<M>);

  /**
   * Body must satisfy the operation's requestBody schema — a misspelled
   * or wrongly-typed field is a compile error. The operation id is passed
   * again (lowercase) to look the schema up.
   */
  const typedJsonBody = <
    T extends Options,
    U extends PathKey<paths>,
    M extends keyof paths[U] & Op,
  >(
    o: T & { url: U; method: Uppercase<M> },
    m: M,
    body: JsonBody<paths[U][M]>
  ) => jsonBody(o, body);

  /**
   * Reads the response as the operation's success schema (200, else 201 —
   * see {@link JsonOk}), so `fetchData`'s return type converges with no
   * manual type arguments. Requires the method already set by
   * {@link typedMethod} to be `Uppercase<M>` — the method and the reader
   * cannot drift apart.
   */
  const typedJson = <
    T extends Options,
    U extends PathKey<paths>,
    M extends keyof paths[U] & Op,
  >(
    o: T & { url: U; method: Uppercase<M> },
    // Inference anchor for M — Uppercase<M> is not invertible, so the
    // operation id must be passed (and is never read at runtime).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    m: M
  ): (T & { url: U; method: Uppercase<M> }) & {
    middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
    [readDataSymbol]: (res: Response) => Promise<JsonOk<paths[U][M]>>;
  } =>
    json<T & { url: U; method: Uppercase<M> }, JsonOk<paths[U][M]>>(o);

  return { typedUrl, typedPath, typedMethod, typedJsonBody, typedJson };
}
