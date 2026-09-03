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
  TypedURLSearchParams,
} from './types';

import { readDataSymbol } from './constants';
import { json, jsonBody, method, path, query, url } from './config';

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
 * A response object declaring `application/json` content — the pattern
 * every success-schema arm of {@link JsonOk} matches.
 */
type JsonContent<D> = { content: { 'application/json': D } };

/**
 * JSON payload of an operation's success response: the first 2xx status
 * whose response declares `application/json` content, checked in the
 * order 200, 201, 202, 203, 206, 226, then the `'2XX'` range — the
 * codes real specs use for JSON successes (`204` and `205` carry no
 * body, so a spec typing them with JSON content is not consulted).
 * Resolves to `unknown` when no enumerated 2xx response declares JSON
 * content; when several do, the earliest in that order wins, so a
 * `200`+`202` spec reads as the `200` schema.
 */
export type JsonOk<O> =
  O extends { responses: { 200: JsonContent<infer D> } }
    ? D
    : O extends { responses: { 201: JsonContent<infer D> } }
      ? D
      : O extends { responses: { 202: JsonContent<infer D> } }
        ? D
        : O extends { responses: { 203: JsonContent<infer D> } }
          ? D
          : O extends { responses: { 206: JsonContent<infer D> } }
            ? D
            : O extends { responses: { 226: JsonContent<infer D> } }
              ? D
              : O extends { responses: { '2XX': JsonContent<infer D> } }
                ? D
                : unknown;

/**
 * The query-parameter object a path accepts: the path item's
 * `parameters.query` record from the generated `paths` type, every entry
 * optional (omit the whole call to send none), values typed as the spec
 * declares them and stringified at runtime. `undefined` when the path
 * declares no query parameters — there is nothing valid to pass.
 */
export type QueryParams<paths, U extends PathKey<paths>> =
  paths[U] extends { parameters: { query?: infer Q } }
    ? Q extends Record<string, unknown>
      ? { [K in keyof Q]?: Q[K] }
      : undefined
    : undefined;

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
   * Query parameters must be the path item's `parameters.query` record —
   * a key the spec does not declare is a compile error, and a path
   * without query parameters accepts nothing. Every entry is optional;
   * values keep their spec types (`number`, `boolean`, arrays for
   * repeated keys) and are stringified at runtime, arrays expanding to
   * repeated keys. Delegates to the config-side `query`, so the whole
   * untyped pipe surface (`mergeQuery`, `querySet`, ...) stays in play.
   *
   * Note: operation-level `parameters` (declared inside a single `get`/
   * `post`/...) are not consulted — merge those specs into the path-item
   * level, or use the untyped `query` for them.
   */
  const typedQuery = <T extends Options, U extends PathKey<paths>>(
    o: T & { url: U },
    params: QueryParams<paths, U>
  ): Omit<T, 'searchParams'> & {
    url: U;
    searchParams: TypedURLSearchParams;
  } => {
    const entries: [string, string][] = [];
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) entries.push([key, String(item)]);
      } else {
        entries.push([key, String(value)]);
      }
    }
    return query(o, entries) as Omit<T, 'searchParams'> & {
      url: U;
      searchParams: TypedURLSearchParams;
    };
  };

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
   * or wrongly-typed field is a compile error.
   *
   * The lowercase operation id may be echoed to pin the lookup
   * (`typedJsonBody(o, 'post', body)`), or omitted entirely
   * (`typedJsonBody(o, body)`) — the operation is then inferred from the
   * method phantom type set by `typedMethod`, and the body is checked
   * against that operation's schema.
   */
  const typedJsonBody = <
    T extends Options,
    U extends PathKey<paths>,
    MM extends Uppercase<keyof paths[U] & Op> = Uppercase<
      keyof paths[U] & Op
    >,
    M extends Lowercase<MM> & keyof paths[U] & Op = Lowercase<MM> &
      keyof paths[U] &
      Op,
  >(
    o: T & { url: U; method: MM },
    mOrBody: M | JsonBody<paths[U][M]>,
    body?: JsonBody<paths[U][M]>
  ) =>
    jsonBody(o, body !== undefined ? body : mOrBody);

  /**
   * Reads the response as the operation's success schema (see
   * {@link JsonOk} — first JSON-carrying 2xx, 200 before 201), so
   * `fetchData`'s return type converges with no manual type arguments.
   *
   * The lowercase operation id may be echoed to pin the lookup
   * (`typedJson(o, 'get')`), or omitted (`typedJson(o)`) — the operation
   * is then inferred from the method phantom type set by
   * `typedMethod`. An echoed id that disagrees with the stored method
   * fails to compile: the method and the reader cannot drift apart.
   */
  const typedJson = <
    T extends Options,
    U extends PathKey<paths>,
    MM extends Uppercase<keyof paths[U] & Op> = Uppercase<
      keyof paths[U] & Op
    >,
    M extends Lowercase<MM> & keyof paths[U] & Op = Lowercase<MM> &
      keyof paths[U] &
      Op,
  >(
    o: T & { url: U; method: MM },
    m?: M
  ): (T & { url: U; method: MM }) & {
    middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
    [readDataSymbol]: (res: Response) => Promise<JsonOk<paths[U][M]>>;
  } => json<T & { url: U; method: MM }, JsonOk<paths[U][M]>>(o);

  return {
    typedUrl,
    typedPath,
    typedQuery,
    typedMethod,
    typedJsonBody,
    typedJson,
  };
}
