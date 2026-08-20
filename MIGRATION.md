# Migration Guide

How to upgrade between fetch-fun releases. Each section covers one version step and is organized into **Breaking changes** (with copy-paste fixes), **Behavior changes** (observable, but usually requiring no action), and **Additive** changes, followed by a migration checklist.

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

- **URL joining is slash-normalized.** Trailing slashes on `baseUrl` and leading slashes on `url` collapse into a single `/`, and an absolute `url` (own protocol) bypasses `baseUrl` entirely. 0.4.x concatenated the two strings verbatim.
- **Middleware misconfiguration now throws.** Duplicate middleware names and dependency cycles throw with a named message. 0.4.x silently overwrote duplicate names and fell back to pipe order on cycles (with a `console.warn`).
- **`fetch()` returns the real `Response`.** Reader middlewares (`json`, `text`, `blob`, `data`) store parsed data in a WeakMap instead of returning a spread copy of the response — in 0.4.x, once a reader ran, the value from `fetch()` lost the `Response` prototype (`.status`, `.headers`, `.body` read as `undefined`). `getData(res)` works exactly as before.
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

### Migrate

- [ ] Handle `HTTPError` from `fetchData` / `fetchJSON` (or switch to `fetch` + `res.ok` to keep resolving semantics).
- [ ] Replace `e instanceof TypeError` network checks with `e instanceof NetworkError`.
- [ ] Review retry defaults: add `methods` (or `shouldRetry`) if `POST` / `PATCH` must retry, and `statuses` if you need other codes retried.
- [ ] Send JSON with `jsonBody` if you relied on `json()`'s implicit `Content-Type`.
- [ ] Custom `fetch` mocks / middlewares: read headers via `new Headers(init.headers).get(...)`.
- [ ] Read `.timeoutMs` (not `.signal`) off options piped through `timeout`.
- [ ] Update any direct `dist/...` import paths.
