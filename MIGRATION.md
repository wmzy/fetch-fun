# Migration Guide

How to upgrade between fetch-fun releases. Each section covers one version step and is organized into **Breaking changes** (with copy-paste fixes), **Behavior changes** (observable, but usually requiring no action), and **Additive** changes, followed by a migration checklist. Coming from ky? The [last section](#migrating-from-ky) maps ky 2.0 concepts to fetch-fun.

## v0.3 → v0.4

> 0.4.1 and 0.4.2 were CI-only patch releases — everything below shipped in 0.4.0.

### Breaking changes

#### 1. `error()` renamed to `checkError()`

The config function that inspects a response and may throw was renamed for clarity (`error` collided with too many local variables).

```typescript
// ❌ Before (0.3.x)
client.pipe(ff.error, (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
});

// ✅ After (0.4.x)
client.pipe(ff.checkError, (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
});
```

#### 2. Middleware model rework

Middlewares keep the `(fetchFn, instance) => fetchFn` shape (now typed `MiddlewareFn`; the old `Middleware` alias still points at it), but:

- `use` / `middlewares` also accept config objects `{ name, outer, inner, middleware }` for declarative positioning (`outer: X` = this middleware wraps `X`).
- The stored `middlewares` array now holds normalized `MiddlewareEntry` objects, not bare functions.
- The list is **sorted** by positioning constraints before execution, so declared `outer`/`inner` relationships can reorder it relative to pipe order.

```typescript
// ❌ Before (0.3.x): bare function, stored and executed in pipe order
const timing: ff.Middleware = (f, o) => (...params) => f(...params);
client.pipe(ff.use, timing);
options.middlewares[0](fetchFn, options); // entries were callable

// ✅ After (0.4.x)
const timing: ff.MiddlewareFn = (f, o) => (...params) => f(...params);
client.pipe(ff.use, timing); // bare function → anonymous NORMAL-group entry
// or with positioning:
client.pipe(ff.use, { name: 'trace', outer: ff.NORMAL, middleware: timing });
options.middlewares[0].middleware(fetchFn, options); // entries, topologically sorted
```

#### 3. `toFetchPrams` → `toFetchParams`

Typo fix in the exported utility name. Only affects direct imports of the helper.

```typescript
// ❌ Before (0.3.x)
import { toFetchPrams } from 'fetch-fun';

// ✅ After (0.4.x)
import { toFetchParams } from 'fetch-fun';
```

### Behavior changes

- **`json()` now sets `Content-Type: application/json` on the request.** 0.3.x only configured response parsing. (Removed again in 0.5.0 — see the next section.)
- **Retry honors `asNotRetryError()` and caps its backoff.** `createRetry(n)` still retries every failure, but errors wrapped with `asNotRetryError()` now rethrow immediately, and the exponential backoff is capped at 10 s with ±25% jitter (0.3.x: uncapped `1000 · 2^attempt`, no jitter, no opt-out).

### Additive

- Query utilities: `query`, `mergeQuery`, `querySet`, `queryAppend`, plus `createQuery` and type-tracked `searchParams`.
- Middleware factories with reserved names and positions: `withRetry`, `withTimeout`, `withAuth`, `withLogging`; ordering helpers `sortMiddlewares` / `normalizeMiddleware`.
- Config functions: `signal`, `timeout`.
- `asNotRetryError` / `isNotRetryError` utilities.
- `Method` gains `'OPTIONS'`.

### Migrate

- [ ] Rename `error` → `checkError` in pipes and imports.
- [ ] Update custom middleware type annotations to `MiddlewareFn`, and anything that reads `o.middlewares` directly (entries are `{ name, middleware, ... }` objects, sorted by positioning).
- [ ] Rename `toFetchPrams` imports to `toFetchParams`.

## v0.4 → v0.5 (unreleased)

0.5.0 adds typed errors, a smart retry policy, Standard Schema validation, and interop fixes. It now declares `engines: { node: ">=20.3" }` (for `AbortSignal.any`); for browsers nothing changes beyond needing a modern engine.

### Breaking changes

#### 1. `fetchData` / `fetchJSON` throw `HTTPError` on non-2xx responses

0.4.x resolved non-2xx requests with the parsed body — a 404 came back as data. 0.5.0 rejects with `HTTPError` carrying `response`, a best-effort reconstructed `request`, and `data` (the parsed error body, when a reader such as `json` already ran).

```typescript
// ❌ Before (0.4.x): non-2xx resolves — status handling was entirely up to you
const body = await client
  .pipe(ff.url, '/users/42')
  .pipe(ff.fetchJSON); // a 404 resolves with the parsed error body

// ✅ After (0.5.0): non-2xx rejects with HTTPError
try {
  const user = await client.pipe(ff.url, '/users/42').pipe(ff.fetchJSON);
} catch (e) {
  if (e instanceof ff.HTTPError) {
    console.log(e.response.status); // e.g. 404
    console.log(e.data); // parsed error body, when a reader ran
  }
}

// Prefer deciding yourself? fetch() never throws on status:
const res = await client.pipe(ff.url, '/users/42').pipe(ff.fetch);
if (res.ok) { /* ... */ }
```

#### 2. Network failures reject with `NetworkError` instead of a bare `TypeError`

Only a `TypeError` from the innermost native fetch (DNS failure, connection refused, TLS error, offline — while the signal has not aborted) is wrapped. The original `TypeError` is preserved as `cause`, and a best-effort `url` is attached. Aborts and errors thrown by your own middlewares keep their identity; `retry` still treats `NetworkError` as retryable.

```typescript
// ❌ Before (0.4.x)
} catch (e) {
  if (e instanceof TypeError) toast('You appear to be offline');
}

// ✅ After (0.5.0)
} catch (e) {
  if (e instanceof ff.NetworkError) toast('You appear to be offline');
  // e.url — best-effort URL of the failed request
  // e.cause — the original TypeError from fetch
}
```

#### 3. `retry` is method- and status-aware by default

0.4.x retried every failure up to `maxRetries`. 0.5.0 retries only when it is safe and sensible (see the [retry decision matrix](README.md#retry--decision-matrix)):

- Only idempotent methods retry by default: `GET HEAD OPTIONS TRACE PUT DELETE`. `POST` / `PATCH` never retry, to avoid duplicating side effects.
- Resolved responses retry only on transient statuses (default `408 425 429 500 502 503 504`); a 404 resolves as-is instead of burning retries.
- `HTTPError` thrown by your `checkError` retries only when its status is retryable; `ValidationError` and `asNotRetryError()`-wrapped errors never retry.

```typescript
// ❌ Before (0.4.x): POST retried on every failure
client.pipe(ff.method, 'POST').pipe(ff.retry, 3);

// ✅ After (0.5.0): opt non-idempotent methods back in explicitly…
client
  .pipe(ff.method, 'POST')
  .pipe(ff.retry, 3, { methods: ['GET', 'POST'] });

// …or replace the whole retry decision with a predicate
client.pipe(ff.retry, 3, {
  shouldRetry: (attempt, { response, error }) =>
    error != null || (response?.status ?? 0) >= 500,
});
```

`shouldRetry` fully replaces the status-set / error-classification decisions; the hard rules still apply first — non-retryable methods never retry, attempts stop at `maxRetries`, and `ValidationError` / `asNotRetryError` rejections are rethrown.

#### 4. `json()` no longer sets a request `Content-Type`

0.4.x's `json()` also set `Content-Type: application/json` on the request — meaningless for the GETs it is usually paired with. 0.5.0 configures response parsing only.

```typescript
// ❌ Before (0.4.x): response reader plus an implicit request header
client.pipe(ff.url, '/users').pipe(ff.method, 'POST').pipe(ff.json);
// sent Content-Type: application/json with no body to describe

// ✅ After (0.5.0): send JSON explicitly
client
  .pipe(ff.url, '/users')
  .pipe(ff.method, 'POST')
  .pipe(ff.jsonBody, { name: 'Alice' });
// jsonBody sets the body AND Content-Type: application/json;
// or set headers yourself with contentType / header.
```

#### 5. `withAuth` passes a `Headers` instance to the inner fetch

0.4.x spread `init.headers` into a plain object, silently dropping every header already packed into a `Headers` instance. 0.5.0 builds `new Headers(init.headers)`, sets `Authorization`, and passes the instance along. Requests through native fetch are unchanged — but a custom `fetch` implementation (including test mocks) or middleware that reads `init.headers` as a plain record must switch to the `Headers` API.

```typescript
// ❌ Before (0.4.x): mock reading headers as a record
const mockFetch = async (input, init) => {
  const auth = (init?.headers as Record<string, string>)['Authorization'];
  // undefined once withAuth (or anything else) passes a Headers instance
};

// ✅ After (0.5.0): accept every HeadersInit shape
const mockFetch = async (input, init) => {
  const auth = new Headers(init?.headers).get('Authorization');
};
```

#### 6. `timeout()` is lazy, per-attempt, and typed

0.4.x created `AbortSignal.timeout(ms)` **at pipe time** — a reused client inherited a depleted or expired budget — and overwrote any `signal` already set. 0.5.0 stores `timeoutMs`; every attempt (including each retry) gets a **fresh** budget when the request executes, combined with your `signal` via `AbortSignal.any`. An elapsed budget now throws `TimeoutError` (with the underlying `DOMException` as `cause`) instead of propagating a raw abort. The piped type changed accordingly: `{ signal: AbortSignal }` → `{ timeoutMs: number }`.

```typescript
// ❌ Before (0.4.x): eager timer, clobbers your signal, DOMException on timeout
const o = client
  .pipe(ff.signal, controller.signal)
  .pipe(ff.timeout, 5000);
// o.signal is the timeout signal — controller.signal was lost

// ✅ After (0.5.0): lazy budget, both signals honored, TimeoutError on timeout
const o = client
  .pipe(ff.signal, controller.signal)
  .pipe(ff.timeout, 5000);
// o.timeoutMs === 5000; the timer starts when the request executes
```

`withTimeout(ms)` moved from outside `builtin:retry` (one budget shared by all attempts) to inside it (a fresh budget per attempt).

#### 7. Artifact paths renamed

`dist/index.cjs.js` → `dist/index.cjs`, `dist/index.es.js` → `dist/index.mjs`, and type declarations are now dual: `dist/types/index.d.ts` (CJS) and `dist/types/index.d.mts` (ESM), behind a proper `exports` map. Only code importing dist internals by path is affected — importing from the package root is unchanged.

```typescript
// ❌ Before (0.4.x)
import { fetch } from 'fetch-fun/dist/index.es.js';

// ✅ After (0.5.0)
import { fetch } from 'fetch-fun'; // root import unchanged
import { fetch } from 'fetch-fun/dist/index.mjs'; // deep import, new path
```

### Behavior changes

- **URL joining is slash-normalized.** Trailing slashes on `baseUrl` and leading slashes on `url` collapse into a single `/`, and an absolute `url` (own protocol) bypasses `baseUrl` entirely. 0.4.x concatenated the two strings verbatim. `../` segments in the path are preserved as-is — the join is textual splicing, not URL resolution, so the server receives the dot segments.
- **Protocol-relative URLs bypass `baseUrl`.** A `url` starting with `//` now passes through untouched, inheriting the caller's protocol. 0.4.x silently concatenated it onto the `baseUrl` prefix, sending the request to a path under the base instead of the intended host.
- **Middleware misconfiguration now throws.** Duplicate middleware names and dependency cycles throw with a named message. 0.4.x silently overwrote duplicate names and fell back to pipe order on cycles (with a `console.warn`).
- **`fetch()` returns the real `Response`.** Reader middlewares (`json`, `text`, `blob`, `data`) store parsed data in a WeakMap instead of returning a spread copy of the response — in 0.4.x, once a reader ran, the value from `fetch()` lost the `Response` prototype (`.status`, `.headers`, `.body` read as `undefined`). `getData(res)` works exactly as before.
- **Opaque (`no-cors`) responses no longer throw `HTTPError`.** A response with `type: 'opaque'` (status `0`) resolves from `fetchData` / `fetchJSON` like any other response — matching ky 2.0 — instead of rejecting with an uninformative `HTTPError`; any problem reading the opaque body surfaces from the reader itself.
- **`Retry-After` is honored and capped.** A parseable, non-past `Retry-After` header (integer seconds or HTTP-date) overrides the backoff delay, clamped to `maxRetryAfter` (default `30000` ms) — the retry still happens, just sooner than the server demanded.
- **Discarded retry responses release their bodies** (`res.body.cancel()`) before the wait, avoiding connection leaks.
- **Wider inputs, same storage.** `headers()` / `header()` accept `Headers` instances and `[name, value][]` tuples (normalized to plain records), and `body()` accepts any `BodyInit | null` (0.4.x: strings only). All backward compatible.

### Additive

- Method sugar: `get` / `post` / `put` / `patch` / `del` / `head` — `client.pipe(ff.post, '/users', { name: 'Alice' })` sets method, URL, and JSON body in one step. Each argument is optional: an omitted path keeps the existing `url`, an omitted body leaves `body` untouched. (`del`, because `delete` is a reserved word.)
- `withProgress({ onDownloadProgress, onUploadProgress })` — per-chunk `{ percent, transferred, total }` callbacks. `total` comes from `Content-Length` (`0` / `percent: 0` when absent); null-body responses (`204` / `205` / `HEAD`) are not wrapped; uploads are counted only when `init.body` is a `ReadableStream`.
- `validate(o, schema)` — Standard Schema v1 validation (Zod / Valibot / ArkType, duck-typed) of parsed response data; failures reject `fetchData` / `fetchJSON` with `ValidationError` (`issues`, `data`), and the inferred data type converges to the schema output.
- Error classes exported from the root: `HTTPError`, `TimeoutError`, `ValidationError`, `NetworkError` (see [Errors](README.md#errors)).
- `RetryOptions.shouldRetry` and `RetryOptions.maxRetryAfter` (see Breaking changes #3).
- Query values widen to `string | number | boolean` in `query` / `mergeQuery` / `querySet` / `queryAppend` — stringified with `String()` at runtime (`true` → `'true'`), tracked as string literals at the type level (`querySet(o, 'page', 1)` tracks `'1'`).
- `Method` accepts arbitrary custom strings (`string & {}`).
- Response readers: `arrayBuffer(o)` and `formData(o)` join `json` / `text` / `blob`; `json(o, parseJson?)` accepts a custom parser (e.g. a `JSON.parse` reviver reviving `Date`s) whose return type flows into `fetchData` inference.
- `withAuth(credentials, type = 'Bearer')` — the middleware now supports any auth scheme (`'Basic' | 'Bearer' | 'Digest' | string`), matching the `auth(o, type, credentials)` config function; single-argument calls stay Bearer.
- Bundle guardrails in CI: `size-limit` (full client ≈ 5 kB min+gzip; a `create` + `url` + `fetchJSON` + `json` app ≈ 2 kB) and a tree-shaking verification script asserting `withRetry` / `withAuth` / `withLogging` / `withProgress` code is dropped when unused (`npm run size`, `npm run verify:tree-shaking`).
- `mapError(o, mapper)` — map any rejection right before it escapes `fetchData` / `fetchJSON` (ky's `beforeError` hook): the mapper receives `(error, ctx)` where `ctx` carries `{ response, request }` for `HTTPError`s and `{}` otherwise, and its — possibly async — return value becomes the rejection reason. A later pipe overwrites an earlier mapper, `retry` always sees the original error, and raw `fetch()` bypasses it entirely.
- `withProgress({ wrapBody: true })` — wrap string / `Blob` / `ArrayBuffer` / `ArrayBufferView` / `URLSearchParams` request bodies into a counting stream so `onUploadProgress` fires for them too, with `total` set to the body's real byte size (making `percent` meaningful); the implicit `Content-Type` those shapes lose when streamed is restored, and `duplex: 'half'` is set automatically. `FormData` and `ReadableStream` bodies are unaffected.

### Migrate

- [ ] Handle `HTTPError` from `fetchData` / `fetchJSON` (or switch to `fetch` + `res.ok` to keep resolving semantics).
- [ ] Replace `e instanceof TypeError` network checks with `e instanceof NetworkError`.
- [ ] Review retry defaults: add `methods` (or `shouldRetry`) if `POST` / `PATCH` must retry, and `statuses` if you need other codes retried.
- [ ] Send JSON with `jsonBody` if you relied on `json()`'s implicit `Content-Type`.
- [ ] Custom `fetch` mocks / middlewares: read headers via `new Headers(init.headers).get(...)`.
- [ ] Read `.timeoutMs` (not `.signal`) off options piped through `timeout`.
- [ ] Update any direct `dist/...` import paths.

## Migrating from ky

fetch-fun is not a drop-in ky replacement: where ky configures an instance with options and lifecycle hooks, fetch-fun composes plain pipeable functions over an options object. The feature sets overlap heavily, though, and most ky code translates mechanically. The table below maps ky 2.0 concepts to their fetch-fun equivalents; where ky 1.x named an option differently (`prefixUrl`), that is called out too.

### Concept map

| ky 2.0 | fetch-fun | Notes |
| --- | --- | --- |
| `ky.create(defaults)` | `create(o)` | Fresh client from a defaults object. |
| `ky.extend(defaults)` | `client.pipe(...)` | Derives a new client inheriting everything; pipes are immutable, so the parent is never mutated. Merge rules differ per pipe: `query` / `headers` replace, `mergeQuery` / `header` merge. ky's `extend` deep-merges options and appends hooks; its `replaceOption` escape hatch is unnecessary here — pick the replacing pipe explicitly. |
| `prefixUrl` (1.x) / `prefix` (2.0) | `baseUrl` | Splice semantics match: trailing / leading slashes collapse at the join, leading-slash inputs included. |
| `baseUrl` (2.0) | — | No direct equivalent. ky *resolves* the input as a relative URL (`new URL(input, base)`: a leading slash goes origin-root, `../` collapses, the base may carry a query), while fetch-fun's `baseUrl` always *splices* (`'/users'` against `https://x/api/` → `https://x/api/users`). Pre-resolve with `new URL()` and pass the absolute `url` — see [URL building](#url-building-splice-vs-resolve). |
| `json` (request option) | `jsonBody(o, data)` | Or the method sugar: `post(o, '/users', payload)` sets method, URL, and JSON body in one step. |
| `searchParams` | `query` / `mergeQuery` / `querySet` / `queryAppend` | ky merges with the query already on the input URL (and `extend` accumulates instances' params); fetch-fun splits that into `mergeQuery` (append-merge — the closest match) and `query` (replace, ky's `replaceOption`). See [Query parameters](#query-parameters-merge-vs-replace). |
| `retry.limit` | `retry(o, maxRetries)` | **Default gap: ky retries twice out of the box; fetch-fun never retries unless `retry` is piped.** |
| `retry.methods` | `RetryOptions.methods` | Both default to idempotent methods; ky additionally lists `QUERY`. |
| `retry.statusCodes` | `RetryOptions.statuses` | ky defaults to `408 413 429 500 502 503 504`; fetch-fun to `408 425 429 500 502 503 504` — `425` instead of `413` (`413` is never retried in fetch-fun). |
| `retry.delay` + `retry.backoffLimit` | `RetryOptions.delay` | ky: a `delay(attemptCount)` function, default `0.3 · 2^(n−1) · 1000` ms, jitter opt-in. fetch-fun: `{ initial: 1000, max: 10000, multiplier: 2 }` with ±25% jitter always applied. |
| `retry.afterStatusCodes` + `retry.maxRetryAfter` | `respectRetryAfter` + `maxRetryAfter` | ky honors `Retry-After` (plus rate-limit headers) only for `afterStatusCodes` (`413 429 503`) and defaults its cap to `Infinity`. fetch-fun honors `Retry-After` (seconds or HTTP-date) on any retry and defaults the cap to `30000` ms. |
| `retry.retryOnTimeout` | — | Timeouts are ordinary retryable rejections in fetch-fun — there is no separate switch (opt out via `shouldRetry`). ky defaults to *not* retrying timeouts. |
| `retry.shouldRetry` | `RetryOptions.shouldRetry` | Both replace the built-in retry decisions; fetch-fun's hard rules still apply first (method gate, `maxRetries` budget, `ValidationError` never retried). |
| `hooks.init` | pipe a config function, or a middleware via `use` | Config functions are pure and pipes immutable, so "reset / derive per-request state" is just piping at the call site; a middleware covers the must-run-on-every-request cases. See [Hooks](#hooks--middlewares-and-maperror). |
| `hooks.beforeRequest` | middleware via `use` | A middleware wraps `(input, init)` before fetch: rewrite URL / headers, or return a `Response` yourself to short-circuit (ky's mock / cache pattern). |
| `hooks.afterResponse` | `mapResponse(o, mapper)` or a middleware | Inspect or replace the `Response`. ky's `ky.retry(...)` force-retry maps to a `shouldRetry` predicate. |
| `hooks.beforeRetry` | `createRetryBase(beforeRetry)` | Fully custom retry loop: `(attempt, error, o) => Promise<void>`; reject to stop (ky's `ky.stop` symbol becomes a plain rejection). |
| `hooks.beforeError` | `mapError(o, mapper)` | Transform any rejection right before it escapes `fetchData` / `fetchJSON`; the return value is what callers catch. |
| `timeout` (default `10000`, `false` disables) | `timeout(o, ms)` (no default) | Both are per-attempt — a fresh budget on every retry. **Default gap: every ky request carries an implicit 10 s timeout; with fetch-fun nothing times out until you pipe it** (and "disabling" simply means not piping it). |
| `totalTimeout` | `totalTimeout(o, ms)` | Same shape: one budget over all attempts and backoff waits; rejects with `TimeoutError` when exceeded. |
| `throwHttpErrors: false` | `fetch(o)` | The executor resolves the `Response` for any status — check `res.ok` yourself. |
| `parseJson` | `json(o, parseJson)` | Custom response-JSON parser (bourne, `JSON.parse` revivers, …); its return type flows into `fetchData`'s inference. |
| `stringifyJson` | `body(o, str)` + `contentType(o, 'application/json')` | `jsonBody` always uses `JSON.stringify` — serialize yourself when you need a custom stringifier. |
| `.json(schema)` → `SchemaValidationError` | `pipe(validate, schema)` → `ValidationError` | Both take any Standard Schema v1 schema (Zod / Valibot / ArkType) with zero adapters. |
| `onDownloadProgress` | `withProgress({ onDownloadProgress })` | Same per-chunk `{ percent, transferred, total }` shape (ky spells the fields `transferredBytes` / `totalBytes`). |
| `onUploadProgress` | `withProgress({ onUploadProgress, wrapBody: true })` | fetch-fun counts `ReadableStream` bodies natively (`total: 0` — unknown length) and wraps string / `Blob` / `ArrayBuffer` / view / `URLSearchParams` bodies when `wrapBody: true`, giving a real byte `total`, restoring the implicit `Content-Type`, and setting `duplex: 'half'` automatically. |
| `fetch` option | `create({ fetch: myFetch })` | Custom fetch implementation (SSR wrappers, instrumentation, test doubles). |
| `HTTPError` / `TimeoutError` / `NetworkError` | same names | Field-level differences: fetch-fun's `HTTPError` carries `.response` / `.request` / `.data`; `SchemaValidationError` maps to `ValidationError`. |
| Node.js 22+ | Node.js >= 20.3 | fetch-fun only needs `AbortSignal.any` and `AbortSignal.timeout`. |

### Instances and base URL

```typescript
// ky 2.0: instances with defaults; extend() inherits and deep-merges
const kyApi = ky.create({
  baseUrl: 'https://api.example.com',
  headers: { accept: 'application/json' },
});
const kyUsersApi = kyApi.extend({ prefix: '/users' });

// fetch-fun: create() + pipes; derived clients inherit immutably
const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.accept, 'application/json');
const usersApi = api.pipe(ff.baseUrl, 'https://api.example.com/users'); // api itself unchanged
```

Three URL cases worth knowing when moving off `prefixUrl` / `prefix`:

```typescript
client.pipe(ff.url, 'users');  // https://api.example.com/users — slash-normalized splice
client.pipe(ff.url, '/users'); // https://api.example.com/users — same result
client.pipe(ff.url, 'https://other.example.com/x'); // bypasses baseUrl entirely
```

- An absolute `url` (own protocol) bypasses `baseUrl` in both libraries.
- A protocol-relative `url` (`//cdn.example.com/x`) passes through untouched, inheriting the page's protocol — ky 2.0 instead resolves it against its `baseUrl`.

### URL building: splice vs resolve

ky 2.0 split the single 1.x `prefixUrl` into two options with different algorithms; fetch-fun's `baseUrl` is the splicing one, and there is no resolving mode. All cells below live on the origin `https://x`:

| input | ky 2.0 `prefix: '/api'` | ky 2.0 `baseUrl: 'https://x/api/'` | fetch-fun `baseUrl: 'https://x/api'` |
| --- | --- | --- | --- |
| `users` | `https://x/api/users` | `https://x/api/users` | `https://x/api/users` |
| `/users` | `https://x/api/users` | `https://x/users` | `https://x/api/users` |
| `../users` | `https://x/users` | `https://x/users` | `https://x/api/../users` |

- **Leading slash:** ky's `baseUrl` treats it as origin-root (the base's path is discarded); `prefix` and fetch-fun both trim it at the join and append anyway.
- **Dot segments:** both ky modes end in standard URL resolution, so `../` collapses; fetch-fun splices strings and passes dot segments through — the server receives `api/../users` verbatim.
- **Query on the base:** a `baseUrl` carrying its own query (`https://x/api?v=1`) is legal in ky and broken in fetch-fun (the splice would corrupt the path). Move those params into `query` / `mergeQuery` instead — they are appended after any query already on the `url`.

If your ky code depends on resolution — `../` collapsing, origin-root leading slashes, or a query-carrying base — pre-resolve it yourself and pass the absolute href as `url`:

```typescript
// ky 2.0: URL resolution does the work
await ky('../avatars/7.png', { baseUrl: 'https://x/api/users/42/' });
//=> https://x/api/avatars/7.png

// fetch-fun: resolve yourself, then pass the absolute URL
const href = new URL('../avatars/7.png', 'https://x/api/users/42/').href;
await client.pipe(ff.url, href).pipe(ff.fetch);
```

### Query parameters: merge vs replace

ky's `searchParams` always merges: entries are appended to the query already on the input URL, and `ky.extend` accumulates instance defaults the same append way (with `replaceOption` as the opt-out). fetch-fun makes each behavior a separate pipe:

- `mergeQuery` — append-merge, the closest match for ky: previously piped params are kept and new entries appended, so per-call params layer over client-level params exactly like ky's option merging.
- `query` — replace: drops previously piped params and starts fresh (ky's `replaceOption`).
- `querySet(o, name, value)` / `queryAppend(o, name, value)` — single-key versions (`set` overwrites that key, `append` allows duplicates); ky needs an object rebuild for the same effect.

A query written inside the `url` string survives both: piped params are appended after it with `&`, mirroring how ky merges into the input URL.

```typescript
// ky 2.0: searchParams merges with the URL's own query, and extend() accumulates
const kyApi = ky.create({ searchParams: { api: 'v1' } });
await kyApi.get('https://x/api/users?team=a', { searchParams: { page: 2 } });
// team=a, api=v1, and page=2 all reach the URL

// fetch-fun: the same layering, explicit — query for client defaults, mergeQuery per call
const api = ff
  .create({ baseUrl: 'https://x/api' })
  .pipe(ff.query, { api: 'v1' });
await api
  .pipe(ff.url, 'users?team=a')
  .pipe(ff.mergeQuery, { page: 2 })
  .pipe(ff.fetch);
//=> https://x/api/users?team=a&api=v1&page=2
```

ky's trick of deleting a parameter by setting its value to `undefined` has no equivalent — rebuild the params with `query` (or filter a `URLSearchParams` yourself) instead.

### Hooks → middlewares and `mapError`

Hooks become middlewares — functions `(fetchFn, options) => fetchFn`, added with `use` — and `beforeError` becomes `mapError`. ky 2.0's `init` hook (which synchronously mutates the options object as each request is created) has two translations:

```typescript
// ky 2.0: derive per-request state by mutating the options at init time
const kyApi = ky.extend({
  hooks: {
    init: [
      (options) => {
        options.searchParams = { apiKey: getApiKey() };
      },
    ],
  },
});

// fetch-fun, option A: pipe a config function at the call site — it
// evaluates when piped, so state is derived per request
const res = await client
  .pipe(ff.query, { apiKey: getApiKey() })
  .pipe(ff.url, '/users')
  .pipe(ff.fetch);

// fetch-fun, option B: a middleware, when it must apply to every request
// without each call site opting in
const withApiKey: ff.MiddlewareFn = (f) => (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('X-Api-Key', getApiKey());
  return f(input, { ...init, headers });
};
const api = client.pipe(ff.use, withApiKey);
```

Config functions are pure — no in-place mutation of the options object — and pipes are immutable, so a shared client is safely reused across requests; the init hook's typical job (resetting or deriving per-request state) is exactly what a pipe at the call site expresses.

```typescript
// ky: mutate the outgoing request before it is sent
const api = ky.extend({
  hooks: {
    beforeRequest: [
      ({ request }) => request.headers.set('Authorization', `token ${token()}`),
    ],
  },
});

// fetch-fun: a middleware wraps the fetch function (or use the built-in factory)
client.pipe(ff.use, ff.withAuth(token()));
```

```typescript
// ky: reshape errors right before they are thrown
const api = ky.extend({
  hooks: {
    beforeError: [({ error }) => toApiError(error)],
  },
});

// fetch-fun: the mapper's return value is the rejection reason
client.pipe(ff.mapError, (e, ctx) =>
  e instanceof ff.HTTPError && ctx.response
    ? new ApiError(e.response.status, e.data)
    : e
);
```

`mapError` context carries `{ response, request }` only when the error is an `HTTPError` (`{}` otherwise); the mapper may be async, a later pipe overwrites an earlier one, and `retry` always sees the original error — only `fetchData` / `fetchJSON` rejections pass through it.

### Status handling and typed errors

```typescript
// ky: resolve error responses instead of throwing
const res = await ky.get('/maybe-missing', { throwHttpErrors: false });
if (res.ok) { /* ... */ }

// fetch-fun: the fetch() executor never throws on status
const res = await client.pipe(ff.url, '/maybe-missing').pipe(ff.fetch);
if (res.ok) { /* ... */ }
```

The typed-error classes keep their names, so `instanceof` chains port directly — with `SchemaValidationError` renamed to `ValidationError`:

```typescript
} catch (e) {
  if (e instanceof ff.HTTPError) { /* e.response, e.request, e.data */ }
  else if (e instanceof ff.NetworkError) { /* e.url, e.cause */ }
  else if (e instanceof ff.TimeoutError) { /* e.cause */ }
  else if (e instanceof ff.ValidationError) { /* e.issues, e.data */ }
}
```

### JSON: bodies, parsing, and schemas

```typescript
// ky: JSON body + custom response parser + schema validation
const user = await ky
  .post('/users', { json: { name: 'Alice' }, parseJson: reviveDates })
  .json(UserSchema);

// fetch-fun
const user = await client
  .pipe(ff.post, '/users', { name: 'Alice' }) // method + URL + JSON body + Content-Type
  .pipe(ff.json, reviveDates)                 // custom response parser
  .pipe(ff.validate, UserSchema)              // Standard Schema validation
  .pipe(ff.fetchData);                        // Promise<schema output>
```

A custom request serializer has no dedicated option — serialize yourself and set the raw body:

```typescript
// ky: stringifyJson
await ky.post('/users', { json: data, stringifyJson: myStringify });

// fetch-fun: serialize, then body + contentType
await client
  .pipe(ff.url, '/users')
  .pipe(ff.method, 'POST')
  .pipe(ff.body, myStringify(data))
  .pipe(ff.contentType, 'application/json')
  .pipe(ff.fetch);
```

### Progress

```typescript
// ky: upload progress for a string/Blob body
const res = await ky.post('/upload', {
  body: blob,
  onUploadProgress: (p) => console.log(`${p.percent * 100}%`),
});

// fetch-fun: wrapBody makes non-stream bodies countable
const res = await client
  .pipe(ff.use, ff.withProgress({
    onUploadProgress: ({ percent, transferred, total }) =>
      console.log(`${(percent * 100).toFixed(1)}% of ${total}`),
    wrapBody: true,
  }))
  .pipe(ff.post, '/upload')
  .pipe(ff.body, blob)
  .pipe(ff.fetch);
```

Downloads work the same way — `onDownloadProgress` fires per chunk as you consume `res.body` (e.g. via `res.blob()`); without a `Content-Length`, `total` stays `0` and `percent` stays `0` while `transferred` still counts bytes.

### Putting it together

A representative request — retry, timeouts, JSON, and query params — before and after:

```typescript
// ── ky 2.0 ──────────────────────────────────────────────
import ky from 'ky';

const api = ky.create({
  baseUrl: 'https://api.example.com',
  timeout: 5000,
  retry: { limit: 2, statusCodes: [429, 500, 502, 503, 504] },
  hooks: { beforeError: [({ error }) => toApiError(error)] },
});

const users = await api
  .get('users', { searchParams: { page: 1, limit: 20 } })
  .json<User[]>();
```

```typescript
// ── fetch-fun ───────────────────────────────────────────
import * as ff from 'fetch-fun';

const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.timeout, 5000)                                    // per attempt
  .pipe(ff.retry, 2, { statuses: [429, 500, 502, 503, 504] })
  .pipe(ff.mapError, (e) => toApiError(e));                  // beforeError

const users = await api
  .pipe(ff.url, '/users')
  .pipe(ff.mergeQuery, { page: 1, limit: 20 })
  .pipe(ff.fetchJSON<User[]>);
```

Behavioral deltas to re-check after porting:

- ky's implicit 10 s per-attempt timeout disappears unless `timeout` is piped (here it is explicit anyway).
- ky retries every request twice by default; fetch-fun retries only where `retry` is piped (also explicit here).
- ky does not retry timeouts by default (`retryOnTimeout: false`); fetch-fun does.
- ky honors `Retry-After` with no cap by default (`maxRetryAfter: Infinity`); fetch-fun clamps honored waits to 30 s.
- `fetchJSON` throws `HTTPError` on non-2xx just like ky's `.json()` — but `fetch()` never does.

### What has no ky equivalent

- **Declarative middleware positioning.** Middlewares carry names and positioning constraints — `client.pipe(ff.use, { name: 'trace', outer: ff.NORMAL, middleware })` — resolved by a topological sort at execution time: `outer: X` wraps `X`, `inner: X` is wrapped by it, and `NORMAL` anchors the default group; duplicate names and cycles throw. ky hooks run in registration order within each category, with no way to interleave categories.
- **Tree-shaking, enforced.** Every helper is an independent named export over zero dependencies: importing `url` + `fetchJSON` never pulls `retry` / `progress` / `validate` code into the bundle. CI asserts it (`npm run size`, `npm run verify:tree-shaking`) — a minimal app stays ≈2 kB min+gzip, the full client ≈5 kB. ky ships behind a single factory entry, so retry, hooks, and progress ride along with every import.
