# Fetch Fun

[![npm version](https://badge.fury.io/js/fetch-fun.svg)](https://badge.fury.io/js/fetch-fun)
[![Build Status](https://github.com/wmzy/fetch-fun/actions/workflows/ci.yml/badge.svg)](https://github.com/wmzy/fetch-fun/actions)
[![Coverage Status](https://coveralls.io/repos/github/wmzy/fetch-fun/badge.svg?branch=main)](https://coveralls.io/repos/github/wmzy/fetch-fun?branch=main)

A functional fetch toolkit built on one composition protocol: **any function of the shape `(o, ...args) => o'` is an extension point**. Config functions, middlewares, executors, and your own helpers are all just pipeable functions over a plain options object — no class hierarchy, no hidden state, zero runtime dependencies.

## Why fetch-fun (vs ky / ofetch / wretch / up-fetch)

| Dimension | fetch-fun | ky | ofetch | wretch | up-fetch |
| --- | --- | --- | --- | --- | --- |
| API style | Plain pipeable functions over a plain options object (`client.pipe(url, '/x')`) | Options-object instance + hooks | `$fetch(url, options)` wrapper fn | Fluent method chain (`.url().get()`) | `upfetch(url, options)` wrapper built from `up(fetch, defaults)` |
| Method sugar | `get`/`post`/`put`/`patch`/`del`/`head` — plain config fns `(o, path?, json?)`, composable like everything else | `ky.get(url, { json })` shortcuts on the instance | `$fetch(url, { method, body })` | `.get()`, `.post(json)` chain verbs | None — plain `method` option, same as fetch |
| Extension model | Any `(o, ...args) => o'` function; middlewares with declarative ordering (`outer`/`inner`/`NORMAL`) | `hooks` (beforeRequest/afterResponse) | Request/response interceptors | Middleware chain with index-based placement | Lifecycle hooks (`onRequest`/`onSuccess`/`onError`/`onRetry`) |
| Request body | `body(o, data)` accepts any `BodyInit \| null`; `jsonBody` stringifies and sets `Content-Type` | `json` option; `body` passed through to fetch | `body` (plain objects auto-serialized) | `.body()` / `.json()` | `body` (plain objects auto-serialized; custom `serializeBody`) |
| Query params | Values `string \| number \| boolean` (runtime-normalized); keys/values tracked as literal types | `searchParams` option | `query`/`params` (ufo serialization) | QueryString addon | `params` object (custom `serializeParams`) |
| Type inference | Reader return type flows into `fetchData`; `pipe(validate, schema)` converges to the schema's Standard Schema output; query keys tracked at type level | Generics at call sites; schema output via `.json(schema)` | Generics at call sites | Generics on the chain | Schema output type drives the response type |
| Error semantics | `fetch` never throws on non-2xx; `fetchData`/`fetchJSON` throw `HTTPError` (`.response`/`.request`/`.data`); typed `TimeoutError`, `NetworkError`, `ValidationError` | Always throws on non-2xx | `FetchError` (`error.data`) + `onResponseError` interceptors | Errors surfaced to `.error()` handlers | Throws `ResponseError` on non-2xx (`reject` opt-out → error-as-value); `ResponseValidationError` on schema failure |
| Network errors | Transport `TypeError`s wrapped as typed `NetworkError` (`url?`, original as `cause`); user middleware errors untouched; still retryable | Wrapped in `NetworkError` | Wrapped in `FetchError` | Native errors | No typed wrapper documented |
| Schema validation | Built-in, Standard Schema v1 (Zod/Valibot/ArkType, duck-typed, zero adapters) | Built-in, Standard Schema (`.json(schema)` throws `SchemaValidationError`) | Bring your own via interceptors | Bring your own via middlewares | Built-in, Standard Schema (Zod/Valibot/ArkType) |
| Retry policy | Method-aware (idempotency), status-aware, exp. backoff + jitter, per-attempt timeout; `Retry-After` honored **and capped** (`maxRetryAfter`); `shouldRetry` predicate for response/error-driven decisions | Status/method filter, backoff, `Retry-After` for 413/429/503 | Retry count/delay + status filter | Bring-your-own retry middleware | `retry: { attempts, delay, when }` — attempts/delay may be functions of the request/attempt |
| Progress | Built-in `withProgress`: per-chunk download progress (`percent`/`transferred`/`total`), upload progress for `ReadableStream` bodies | `onDownloadProgress` / `onUploadProgress` | — | Progress addon | Upload + download via `onRequestStreaming`/`onResponseStreaming` |
| Tree-shaking | 0 deps + `sideEffects: false` + every helper an independent named export — bundlers keep only what you import (`url` + `fetchJSON` never pull in `retry`/`progress`/`validate`; full client ≈ 5 kB min+gzip, a `create`+`url`+`fetchJSON`+`json` app ≈ 2 kB — enforced by CI) | Single factory entry — retry, hooks, and progress ship with every import | `$fetch` wrapper + bundled utilities — one unit, little to shake | Core + addons — unused addons stay out of the bundle | One `up()` builder — the whole client ships as a unit |
| Dependencies | **0** | 0 | Small bundled utility set | 0 | 0 |

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concept: the pipe protocol](#core-concept-the-pipe-protocol)
- [Config Functions Reference](#config-functions-reference)
  - [timeout — lazy, per-attempt budget](#timeout--lazy-per-attempt-budget)
  - [retry — decision matrix](#retry--decision-matrix)
  - [validate — Standard Schema validation](#validate--standard-schema-validation)
- [Executors: fetch / fetchData / fetchJSON](#executors-fetch--fetchdata--fetchjson)
- [Errors](#errors)
- [Middleware and the Positioning System](#middleware-and-the-positioning-system)
- [Type Inference](#type-inference)
- [OpenAPI-typed clients](#openapi-typed-clients)
- [Recipes: data libraries, auth, testing](#recipes-data-libraries-auth-testing)
- [Utilities and Advanced API](#utilities-and-advanced-api)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js >= 20.3 (uses `AbortSignal.any` and `AbortSignal.timeout`), or any modern browser shipping both.
- Native `fetch`.

## Installation

```bash
npm install fetch-fun
```

or

```bash
pnpm add fetch-fun
```

## Quick Start

```typescript
import * as ff from 'fetch-fun';

// A client is just a plain options object with a pipe method.
const client = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.accept, 'application/json');

// GET: describe the request, then execute it.
const users = await client
  .pipe(ff.url, '/users')
  .pipe(ff.querySet, 'page', '1')
  .pipe(ff.timeout, 5000)
  .pipe(ff.retry, 2)
  .pipe(ff.fetchJSON<User[]>);

// POST with a JSON body (jsonBody sets body AND Content-Type).
const created = await client
  .pipe(ff.url, '/users')
  .pipe(ff.method, 'POST')
  .pipe(ff.jsonBody, { name: 'John', email: 'john@example.com' })
  .pipe(ff.fetchJSON);
```

Non-2xx responses reject `fetchJSON`/`fetchData` with an `HTTPError`:

```typescript
import * as ff from 'fetch-fun';

try {
  const user = await client.pipe(ff.url, '/users/42').pipe(ff.fetchJSON);
} catch (e) {
  if (e instanceof ff.HTTPError) {
    console.log(e.response.status); // e.g. 404
    console.log(e.data); // parsed error body, e.g. { message: 'Not Found' }
    console.log(e.request?.url); // best-effort reconstructed Request
  }
}
```

One naming caveat — three different things are called `fetch` here:

- `ff.fetch(o)` is the **executor**: it consumes the options object and returns `Promise<Response>`.
- the `fetch` option in `create({ fetch })` is the **injected implementation**: a custom `typeof globalThis.fetch` used under the hood.
- `globalThis.fetch` is the **native** fetch API the other two build on.

Same name, three roles — when mixing them, make sure you know which one you are holding.

## Core Concept: the pipe protocol

`create()` returns `Options & Pipe`. `pipe`, `add`, and `with` are three aliases for the same operation:

```typescript
const piped = client.pipe(ff.url, '/users');   // calls url(client, '/users')
const added = client.add(ff.url, '/users');    // identical
const with_ = client.with(ff.url, '/users');   // identical
```

Every config function has the shape `(o, ...args) => o'` — it takes the current options object and returns a new one. That is the entire framework:

- Built-in config functions (`url`, `jsonBody`, `timeout`, ...) are just functions you can call directly: `url({ url: '/a' }, '/b')`.
- Your own helpers compose with zero registration: `const page = (o: Options, n: string) => querySet(o, 'page', n);`
- Middlewares are functions `(fetchFn, instance) => fetchFn`, added through `use`.
- Executors terminate the chain and return a `Promise`.

## Config Functions Reference

| Function | Purpose | Key parameters |
| --- | --- | --- |
| `url(o, path)` | Set the request path (joined with `baseUrl` at fetch time) | `path: string` |
| `baseUrl(o, base)` | Set the base prefix for all requests; slash-normalized join, absolute `url` bypasses it | `base: string` |
| `appendUrl(o, path)` | Append a segment to the existing `url` (typed template concat) | `path: string` |
| `query(o, params)` | **Replace** query params | `params`: string / record / tuple array / `URLSearchParams` — values `string \| number \| boolean` |
| `mergeQuery(o, params)` | Merge into existing query params | same input as `query` |
| `querySet(o, name, value)` | Set one param (replaces existing value); key and value tracked at type level (`querySet(o, 'page', 1)` → `{ page: '1' }`) | `name`, `value: string \| number \| boolean` |
| `queryAppend(o, name, value)` | Append one param (duplicates allowed); repeated keys become arrays at type level | `name`, `value: string \| number \| boolean` |
| `method(o, m)` | Set the HTTP method | `'GET' \| 'POST' \| ... \| string` |
| `get(o, path?, json?)` | Method sugar: set method `GET`, optionally the path and a JSON body (`jsonBody` semantics) in one step | `path?: string`, `json?: unknown` |
| `post(o, path?, json?)` | Same sugar for `POST` | same |
| `put(o, path?, json?)` | Same sugar for `PUT` | same |
| `patch(o, path?, json?)` | Same sugar for `PATCH` | same |
| `del(o, path?, json?)` | Same sugar for `DELETE` (named `del` — `delete` is a reserved word) | same |
| `head(o, path?, json?)` | Same sugar for `HEAD` | same |
| `headers(o, h)` | **Replace** all headers (`Headers` instances and tuple arrays are normalized into a plain record) | `h: Record<string, string> \| Headers \| [string, string][]` |
| `header(o, name, value)` | Set one header (merges) | `name`, `value: string` |
| `auth(o, type, credentials)` | Set `Authorization: ${type} ${credentials}` | `'Basic' \| 'Bearer' \| 'Digest' \| string` |
| `accept(o, mime)` | Set the `Accept` header | `mime: string` |
| `contentType(o, type)` | Set the `Content-Type` header | `type: string` |
| `body(o, data)` | Set a raw request body of any kind | `data: BodyInit \| null` |
| `jsonBody(o, data)` | `JSON.stringify` the body and set `Content-Type: application/json` | `data: unknown` |
| `signal(o, s)` | Set an `AbortSignal` for cancellation | `s: AbortSignal` |
| `timeout(o, ms)` | Set a **lazy** per-attempt timeout budget (`timeoutMs`) | `ms: number` |
| `retry(o, maxRetries, opts?)` | Add the smart retry middleware | `maxRetries`, [`RetryOptions`](#retry--decision-matrix) |
| `mapResponse(o, mapper)` | Add a middleware mapping `(res, options) => Response` | `mapper` |
| `checkError(o, check)` | Add a middleware that inspects `res` and may throw | `check: (res) => void \| Promise<void>` |
| `data(o, reader)` | Add a response reader; its return value becomes the request's data | `reader: (res) => unknown` |
| `json(o, parseJson?)` | Reader: parse the response body as JSON (does **not** touch request headers) | `parseJson?: (raw: string) => unknown` — custom parser, e.g. `JSON.parse` with a reviver to revive `Date`s; its return type flows into `fetchData`'s inference |
| `text(o)` | Reader: read the body as text | — |
| `blob(o)` | Reader: read the body as a `Blob` | — |
| `arrayBuffer(o)` | Reader: read the body as an `ArrayBuffer` | — |
| `formData(o)` | Reader: read the body as `FormData` | — |
| `validate(o, schema)` | Attach a Standard Schema v1 schema; parsed data is validated and replaced by its output | `schema: StandardSchema` |
| `use(o, mw)` | Add one middleware (function or `{ name, outer, inner, middleware }` config) | `mw: MiddlewareInput` |
| `middlewares(o, list)` | **Replace** the middleware list | `list: MiddlewareInput[]` |

Notes:

- URL building: `baseUrl` trailing slashes and `url` leading slashes collapse into a single `/`; an absolute `url` (own protocol) bypasses `baseUrl` entirely. `searchParams` are appended with `?` or `&` as needed. A `baseUrl` carrying its own query string is not supported — use `query`/`mergeQuery`.
- `query` accepts anything the `URLSearchParams` constructor accepts, with `number`/`boolean` values stringified along the way (`{ page: 1 }` → `?page=1`). For nested/array serialization, serialize first with your preferred library (`qs`, `query-string`) and pass the string.
- `json()` only configures **response** parsing; it no longer sets a request `Content-Type`. To send JSON use `jsonBody`, or set headers explicitly with `contentType`/`header`.

### timeout — lazy, per-attempt budget

`timeout(o, ms)` only stores `timeoutMs` on the options — no timer starts until the request executes. Each attempt (including every retry attempt) then gets a **fresh** `AbortSignal.timeout(ms)`, combined with your `signal` via `AbortSignal.any`. Piping `timeout` is side-effect free, so a reused client always gets a full budget; a later `timeout` pipe overwrites an earlier one.

```typescript
// Each attempt of each request gets 5 seconds, counted from its own start
const res = await client
  .pipe(ff.url, '/slow')
  .pipe(ff.timeout, 5000)
  .pipe(ff.retry, 2)
  .pipe(ff.fetch);
```

A timeout abort is rethrown as `ff.TimeoutError` with the underlying `DOMException` as `cause`; user-initiated aborts (`AbortError`) propagate unchanged.

### retry — decision matrix

`retry(o, maxRetries, opts?)` retries up to `maxRetries` times (the initial attempt is not counted), gated by method and failure kind:

| Attempt outcome | Retried? |
| --- | --- |
| Resolved, status in `statuses` (default `408 425 429 500 502 503 504`), retryable method | ✅ Yes |
| Resolved, other status (e.g. 404) | ❌ No — response returned as-is |
| Rejected: `NetworkError` (transport failure) / `TimeoutError` / unknown error | ✅ Yes (retryable methods only) |
| Rejected: `HTTPError` (from your `checkError`) with status in `statuses` | ✅ Yes |
| Rejected: `HTTPError` with status **not** in `statuses` | ❌ No |
| Rejected: `ValidationError` | ❌ No — deterministic, retrying cannot fix it |
| Any outcome, method not in `methods` (default `GET HEAD OPTIONS TRACE PUT DELETE`) | ❌ Never |
| Retries exhausted (`attempt >= maxRetries`) | ❌ Rethrows / returns |

When `opts.shouldRetry` is provided, it **replaces** the two built-in decisions above — status-set membership for resolved responses and error classification for rejections — with your own predicate. Hard rules always win regardless of its answer: the method gate and the `maxRetries` budget are checked first, and `ValidationError` rejections are never retried.

`RetryOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `statuses` | `[408, 425, 429, 500, 502, 503, 504]` | Statuses worth retrying; compared case-insensitively on resolved responses and thrown `HTTPError`s |
| `methods` | `['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']` | Idempotent allowlist; non-listed methods never retry (avoids duplicating side effects) |
| `respectRetryAfter` | `true` | A parseable, non-past `Retry-After` header (integer seconds or HTTP-date) overrides backoff |
| `maxRetryAfter` | `30000` | Upper bound (ms) for waits honored from `Retry-After`; a server demanding more is clamped down to it — the retry still happens, just sooner. Only relevant when `respectRetryAfter` is true |
| `shouldRetry` | — (built-in decisions) | Custom predicate `(attempt, { response? \| error? }) => boolean \| Promise<boolean>` that fully replaces the built-in retry decisions (see note above); `attempt` is 0-indexed |
| `delay` | `{ initial: 1000, max: 10000, multiplier: 2 }` | Exponential backoff tuning; delays carry ±25% jitter |

```typescript
// Default policy on an idempotent request
await client.pipe(ff.url, '/flaky').pipe(ff.retry, 3).pipe(ff.fetchJSON);

// Custom policy: also retry POST, only on 503, 5s initial delay
await client.pipe(ff.url, '/jobs').pipe(ff.method, 'POST')
  .pipe(ff.retry, 3, {
    methods: ['GET', 'POST'],
    statuses: [503],
    delay: { initial: 5000 },
  })
  .pipe(ff.fetchJSON);

// Response/error-driven: consult the response body before retrying
await client.pipe(ff.url, '/report').pipe(ff.retry, 2, {
  shouldRetry: async (attempt, { response, error }) => {
    if (response)
      return response.status === 503 &&
        (await response.clone().json()).retryable === true;
    return error instanceof ff.NetworkError; // transport failures, not timeouts
  },
});
```

Backoff waits are interruptible by the client's `signal`, and discarded retry responses have their bodies cancelled before the wait. An honored `Retry-After` never waits longer than `maxRetryAfter` (default 30s) — the value is clamped, not skipped.

### validate — Standard Schema validation

`validate(o, schema)` accepts any [Standard Schema v1](https://standardschema.dev) object — detected by duck typing (`~standard: { version: 1, validate }`), so Zod, Valibot, ArkType, and friends work with zero adapters and zero runtime dependencies. Validation runs after the data reader regardless of pipe order; it is skipped for non-2xx responses so `HTTPError` semantics stay intact.

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const user = await client
  .pipe(ff.url, '/users/1')
  .pipe(ff.json)
  .pipe(ff.validate, UserSchema)
  .pipe(ff.fetchData); // Promise<{ id: number; name: string }>

// A failing schema rejects with ff.ValidationError (e.issues, e.data)
```

On success a transformed/defaulted schema output replaces the stored data; on failure `fetchData`/`fetchJSON` reject with a `ValidationError`. Passing anything that is not a Standard Schema v1 object throws a `TypeError` immediately.

## Executors: fetch / fetchData / fetchJSON

| | `fetch(o)` | `fetchData<T>(o)` | `fetchJSON<T>(o)` |
| --- | --- | --- | --- |
| Non-2xx status | Resolves the `Response` — **never throws on status** | Throws `HTTPError` | Throws `HTTPError` |
| Returns | `Promise<Response>` | `Promise<T>` (parsed data) | `Promise<T>` (parsed JSON) |
| Reader needed | No | Yes — configure `json` / `text` / `blob` / `data` first | No — `fetchJSON` adds the `json` reader itself |
| Transport / timeout / validation errors | Can still throw `NetworkError` / `TimeoutError`; `ValidationError` on 2xx | Same + `HTTPError` | Same + `HTTPError` |

```typescript
// fetch: the raw escape hatch — inspect statuses yourself
const res = await client.pipe(ff.url, '/maybe-missing').pipe(ff.fetch);
if (res.ok) { /* ... */ }

// fetchData: parse-then-throw semantics, with the parsed error body attached
try {
  const list = await client.pipe(ff.url, '/users').pipe(ff.json).pipe(ff.fetchData);
} catch (e) {
  if (e instanceof ff.HTTPError) console.log(e.data); // parsed error body, if any
}
```

All executors require `url` to be set (`Fetchable`). A custom `fetch` implementation can be injected via the `fetch` option (`create({ fetch: myFetch })`).

## Errors

All four classes extend `Error` and are exported from the package root.

| Class | Thrown by | Fields |
| --- | --- | --- |
| `HTTPError` | `fetchData` / `fetchJSON` on `!res.ok` | `response: Response` — the failed response; `request?: Request` — best-effort reconstructed request; `data?: unknown` — parsed error body when a reader (e.g. `json`) already ran |
| `NetworkError` | The innermost wrapper around the base fetch, when fetch itself rejects with a `TypeError` (DNS failure, connection refused, TLS error, offline) | `url?: string` — best-effort URL of the failed request; `cause` — the original `TypeError`; message reads like `GET https://api.example.com/x failed: network error` |
| `TimeoutError` | The timeout layer when the per-attempt budget elapses | `cause` — the underlying `DOMException`; message includes the budget (`Request timed out after 5000ms`) |
| `ValidationError` | `validate` on failing schema | `issues: readonly unknown[]` — the schema's issues (Zod/Valibot/ArkType objects); `data?: unknown` — the unvalidated data that was rejected |

`NetworkError` wrapping sits directly around the base fetch — inside every middleware — so only the transport's own `TypeError`s are relabeled, and only when the signal hasn't aborted: errors thrown by user middlewares and user-initiated aborts keep their identity. `retry` still treats `NetworkError` as retryable.

```typescript
import * as ff from 'fetch-fun';

try {
  await client.pipe(ff.url, '/users/1').pipe(ff.validate, UserSchema).pipe(ff.fetchJSON);
} catch (e) {
  if (e instanceof ff.HTTPError) { /* 4xx/5xx: e.response.status, e.data */ }
  else if (e instanceof ff.NetworkError) { /* transport failed: e.url, e.cause */ }
  else if (e instanceof ff.TimeoutError) { /* budget elapsed: e.cause */ }
  else if (e instanceof ff.ValidationError) { /* schema failed: e.issues, e.data */ }
}
```

## Middleware and the Positioning System

A middleware wraps the fetch function — the classic onion model:

```typescript
import type { MiddlewareFn } from 'fetch-fun';

const timing: MiddlewareFn = (f, o) => async (...params) => {
  const start = Date.now();
  try {
    return await f(...params);
  } finally {
    console.log(`${o.url} took ${Date.now() - start}ms`);
  }
};
```

Add middlewares as a bare function or as a config object with declarative positioning:

```typescript
client.pipe(ff.use, timing); // anonymous, lands in the NORMAL group

client.pipe(ff.use, {
  name: 'trace',          // unique name others can position against
  outer: ff.NORMAL,       // wraps everything positioned NORMAL (the default group)
  middleware: timing,
});
```

- `outer: X` — this middleware wraps `X` (runs before `X` on the way out, after `X` on the way back).
- `inner: X` — this middleware is wrapped by `X`.
- `NORMAL` — a virtual node anchoring the default position: anonymous middlewares keep pipe order inside it, `outer: NORMAL` middlewares precede it, `inner: NORMAL` middlewares follow it.

Built-in middleware factories ship with reserved `builtin:*` names and positions:

| Factory | Name | Position |
| --- | --- | --- |
| `withRetry(maxRetries, opts?)` | `builtin:retry` | — |
| `withTimeout(ms)` | `builtin:timeout` | `inner` of `builtin:retry` — every retry attempt gets a fresh budget |
| `withAuth(token)` | `builtin:auth` | `inner` of `builtin:retry` — each attempt re-applies the `Authorization: Bearer <token>` header |
| `withLogging(logger?)` | `builtin:logging` | `outer` of `NORMAL` — logs request/response/error with duration |
| `withProgress(opts?)` | `builtin:progress` | `inner` of `NORMAL` — inside the default group (and therefore inside retry): every (re)try reports its own progress from zero |

```typescript
const res = await client
  .pipe(ff.use, ff.withLogging())     // outermost of the NORMAL group
  .pipe(ff.use, ff.withRetry(3))      // 'builtin:retry'
  .pipe(ff.use, ff.withTimeout(5000)) // inner of retry → per-attempt budget
  .pipe(ff.use, ff.withAuth(jwt))     // inner of retry → auth on every attempt
  .pipe(ff.url, '/flaky')
  .pipe(ff.fetch);
```

`withProgress` reports progress while bodies stream. Downloads are observed by piping `response.body` through a counting `TransformStream`; callbacks fire per chunk — after `fetch` has already resolved, so consume the body to drive them:

```typescript
// percent ∈ [0, 1], total from Content-Length; without Content-Length,
// total stays 0 and percent stays 0 while transferred still counts bytes
const res = await client
  .pipe(ff.use, ff.withProgress({
    onDownloadProgress: ({ percent, transferred, total }) =>
      console.log(`${transferred}/${total || '?'} bytes (${(percent * 100).toFixed(1)}%)`),
  }))
  .pipe(ff.url, '/assets/report.zip')
  .pipe(ff.fetch);

await res.blob(); // reading the body drives the callbacks
```

Null-body responses (`204`/`205`/`HEAD`, …) are returned untouched and produce no callbacks. `onUploadProgress` fires only when the request `init.body` is a `ReadableStream` — every other body shape (string, `BufferSource`, `Blob`, `URLSearchParams`, `FormData`) passes through uncounted rather than being serialized just to count it; a stream's length is unknown, so `total` is `0` there. Native `fetch` requires `duplex: 'half'` for stream bodies, which callers set themselves.

Ordering rules (applied by `sortMiddlewares`, a topological sort):

- **Duplicate names throw** — `Duplicate middleware name "..."` — including two `builtin:retry`s; use `pipe(retry, n)` / bare functions, which generate unique anonymous names, when you need several of a kind.
- **Cycles throw** — `Middleware dependency cycle detected: a -> b -> a`.
- **Dangling constraints are ignored** — an `outer`/`inner` referencing an unregistered name (other than `NORMAL`) orders nothing and never creates a cycle.

Positioning is resolved at execution time from the final middleware list, so it holds no matter the order middlewares were added in.

## Type Inference

Data types travel through the pipe as phantom types — no casts needed at the call site.

**The reader's return type flows into `fetchData`.** `data(o, reader)` brands the options with a `ReaderData` phantom type, and `fetchData` resolves `Promise<Awaited<R>>`:

```typescript
const feed = await client
  .pipe(ff.url, '/feed.xml')
  .pipe(ff.data, async (res) => parseXML(await res.text()) as Feed)
  .pipe(ff.fetchData); // Promise<Feed> — inferred from the reader
```

**Explicit type parameters** go on the executors:

```typescript
const users = await client
  .pipe(ff.url, '/users')
  .pipe(ff.fetchJSON<User[]>); // Promise<User[]>
```

**`validate` converges the type to the schema's output.** After `pipe(json).pipe(validate, schema)`, `fetchData` returns the schema's Standard Schema `Output` type — works with any Standard Schema v1 vendor (Zod, Valibot, ArkType):

```typescript
const UserSchema = z.object({ id: z.number(), name: z.string() });

const user = await client
  .pipe(ff.url, '/users/1')
  .pipe(ff.json)
  .pipe(ff.validate, UserSchema)
  .pipe(ff.fetchData); // Promise<{ id: number; name: string }>
```

**Query keys are tracked at the type level.** `querySet`/`queryAppend` accumulate `{ key: value }` (repeated keys become tuple types) on the `searchParams` phantom, and `createQuery` builds a typed `URLSearchParams` for IDE hints:

```typescript
const q = ff.createQuery({ page: '1', limit: '10' } as const);
// q._type is { page: '1', limit: '10' } — visible in IDE hover
```

## OpenAPI-typed clients

The phantom types don't stop at hand-written URLs. If your API is described by an OpenAPI schema, `openapi-typescript` can turn the spec into pure types, and a ~60-line helper grafts them onto the pipe: paths, methods, request bodies, and 200-response shapes all become compile-time constraints. Unlike `openapi-fetch` (the dedicated wrapper from the same project), nothing here is a second runtime — it's the same zero-dependency pipe, just carrying better types.

Generate the types from your spec:

```bash
npx openapi-typescript ./openapi.yaml -o ./api-types.d.ts
```

Then keep this helper next to them:

```typescript
// openapi.ts — graft openapi-typescript's `paths` onto fetch-fun's phantom types
import * as ff from 'fetch-fun';
import type { paths } from './api-types';

/** OpenAPI operation ids (excludes openapi-typescript's `parameters` key). */
type Op = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

/** JSON body an operation accepts (`unknown` when the spec defines none). */
type JsonBody<O> = O extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : unknown;

/** JSON payload of an operation's 200 response (`unknown` when absent). */
type JsonOk<O> = O extends {
  responses: { 200: { content: { 'application/json': infer D } } };
}
  ? D
  : unknown;

/** Path must be a real key of the generated `paths` type. */
export function typedUrl<T extends ff.Options, U extends keyof paths & string>(
  o: T,
  path: U
) {
  return ff.url<T, U>(o, path);
}

/** Method must be an operation that exists under that path. */
export function typedMethod<
  T extends ff.Options,
  U extends keyof paths & string,
  M extends keyof paths[U] & Op,
>(o: T & { url: U }, m: M) {
  return ff.method<T & { url: U }, Uppercase<M>>(
    o,
    m.toUpperCase() as Uppercase<M>
  );
}

/** Body must satisfy the operation's requestBody schema. */
export function typedJsonBody<
  T extends ff.Options,
  U extends keyof paths & string,
  M extends keyof paths[U] & Op,
>(
  o: T & { url: U; method: Uppercase<M> },
  m: M,
  body: JsonBody<paths[U][M]>
) {
  return ff.jsonBody(o, body);
}

/** Reads the 200 response as the operation's response schema. */
export function typedJson<
  T extends ff.Options,
  U extends keyof paths & string,
  M extends keyof paths[U] & Op,
>(o: T & { url: U; method: Uppercase<M> }, m: M) {
  return ff.json<T & { url: U; method: Uppercase<M> }, JsonOk<paths[U][M]>>(o);
}
```

Every step of the chain is now checked against the spec — `fetchData` returns the operation's response type with no type arguments:

```typescript
// GET /users → Promise<User[]> — from paths['/users']['get'].responses[200]
const users = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'get')
  .pipe(typedJson, 'get')
  .pipe(ff.fetchData);

// POST /users — body checked against the requestBody schema, response is User
const created = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'post')
  .pipe(typedJsonBody, 'post', { name: 'Ada', email: 'ada@example.com' })
  .pipe(typedJson, 'post')
  .pipe(ff.fetchData);
```

Typos fail loudly: `'/user'` is not a key of `paths`, `'delete'` doesn't exist under `/users`, `{ nome: 'Ada' }` doesn't satisfy `UserInput`, and reading the response for `'post'` right after setting the method to `'get'` is a type error — `typedJson` requires `method: Uppercase<M>`, so the method and the reader can't drift apart.

**Types are a promise, not a guarantee.** The spec-derived type only says what the server *should* return. For runtime enforcement, pair the graft with `validate` — write (or generate) a Standard Schema for the same payload and the two layers agree:

```typescript
const UserListSchema = z.array(UserSchema); // Zod, Valibot, ArkType — any vendor

const users = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'get')
  .pipe(ff.json)
  .pipe(ff.validate, UserListSchema)
  .pipe(ff.fetchData); // Promise<User[]> — and throws ValidationError if the server lies
```

**Know the edges.** `openapi-typescript` emits types only — zero runtime, the same trade fetch-fun makes — so `allOf` and discriminator unions type-check but aren't verified at runtime (that's the `validate` pairing above). Path parameters stay plain strings: `typedUrl` matches literal keys like `'/users/{id}'`, so templated calls need a small template-literal matcher or a cast. And `JsonOk` covers the 200 response — extend the conditional if you want other status codes in the union.

**Versus `openapi-fetch`:** it's a purpose-built client with path-param substitution and its own request hooks done for you; the graft above costs ~60 lines you own, but keeps the whole pipe in play — middleware positioning, retry/timeout, Standard Schema `validate`, injectable fetch — and doesn't care where the `paths` types came from: generated, hand-written, or adopted one endpoint at a time.

## Recipes: data libraries, auth, testing

Short, focused recipes for the places fetch-fun usually ends up living: data-fetching libraries, token rotation, meta-frameworks, tests, and schema validation.

### TanStack Query / SWR

fetch-fun's executor semantics map one-to-one onto what data-fetching hooks expect from a `queryFn` / `fetcher`: *return data, throw on failure*. `fetchData` / `fetchJSON` already do exactly that — and throw a typed `HTTPError` (`.response`, `.data`) on non-2xx — while `fetch` never throws on status at all, so the callback itself decides what a failure means. Either shape plugs in directly: no adapter layer, no error-code unpacking.

```typescript
import { useQuery } from '@tanstack/react-query';
import * as ff from 'fetch-fun';

const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.timeout, 5000) // lazy, per-attempt budget — fresh on every retry
  .pipe(ff.retry, 2); // transport-level retry lives here, not in the query layer

export function useUser(id: number) {
  const query = useQuery({
    queryKey: ['users', id],
    // fetchData: data out, typed HTTPError out — usable as queryFn as-is
    queryFn: () =>
      api.pipe(ff.get, `/users/${id}`).pipe(ff.json).pipe(ff.fetchData<User>),
    select: (user) => user.name, // derived per subscriber, not stored in cache
    retry: false, // fetch-fun already owns the retry policy — don't multiply attempts
  });

  if (query.error instanceof ff.HTTPError) {
    // 4xx/5xx with the parsed error body attached
    console.log(query.error.response.status, query.error.data);
  } else if (query.error instanceof ff.NetworkError) {
    // transport failure: url + the original TypeError as cause
    console.log('request to', query.error.url, 'never reached the server');
  }
  return query;
}
```

When a non-2xx should be *data* rather than an error (optional resources, cacheable misses), switch that one queryFn to `fetch` — status never throws there:

```typescript
queryFn: async () => {
  const res = await api.pipe(ff.get, `/users/${id}`).pipe(ff.fetch);
  return res.ok ? ((await res.json()) as User) : null;
},
```

Mutations are the same pipe (method sugar + JSON body in one step), and in SWR the identical pipe is a drop-in `fetcher`:

```typescript
// mutationFn (TanStack Query)
mutationFn: (input: { id: number; name: string }) =>
  api.pipe(ff.patch, `/users/${input.id}`, { name: input.name })
     .pipe(ff.fetchData<User>),

// SWR
useSWR(['users', id], ([, id]) =>
  api.pipe(ff.get, `/users/${id}`).pipe(ff.json).pipe(ff.fetchData<User>)
);
```

**Retry and timeout split.** TanStack Query retries the *query* (3 attempts by default, blind exponential backoff); fetch-fun retries the *transport* with method/status awareness, `Retry-After` honoring, and a fresh per-attempt timeout. Pick one layer: pipe `retry` and disable the library's (`retry: false` in TanStack Query, `shouldRetryOnError: false` in SWR), or keep the library defaults and don't pipe `retry` — running both multiplies attempts (a 3-retry query over a 2-retry transport is up to 12 requests per outage). Cancellation composes either way: pipe the `signal` TanStack Query hands your `queryFn` through `ff.signal` so unmounts abort the in-flight request.

### 401 → refresh → retry

Token refresh is a middleware concern. At the middleware layer a 401 is still a resolved `Response` — nothing has thrown yet — so you can refresh the token and replay the request before the error machinery ever sees it:

```typescript
import * as ff from 'fetch-fun';

let accessToken = /* read from your auth store */ '';
let refreshing: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  // Single-flight lock: concurrent 401s share one refresh round-trip,
  // so a burst of expiring tokens can't stampede the auth server.
  refreshing ??= (async () => {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include', // the refresh cookie, not the bearer
    });
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    accessToken = ((await res.json()) as { token: string }).token;
  })().finally(() => {
    refreshing = null; // a later 401 triggers a fresh round-trip
  });
  return refreshing;
}

// Middleware function form: (fetchFn, options) => fetchFn.
// The header is built from the live variable, so every attempt —
// first try and replay alike — carries the current token.
const withRefreshOn401: ff.MiddlewareFn = (f) => async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await f(input, { ...init, headers });
  if (res.status !== 401) return res;

  await refreshAccessToken();
  headers.set('Authorization', `Bearer ${accessToken}`);
  return f(input, { ...init, headers }); // exactly one replay, never a loop
};

const authed = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.use, withRefreshOn401)
  .pipe(ff.timeout, 5000);

// A 401 that refreshes successfully resolves normally; a 401 after a
// failed refresh surfaces as the usual typed HTTPError from fetchData.
const me = await authed.pipe(ff.get, '/me').pipe(ff.json).pipe(ff.fetchData<Me>);
```

**Why not just `withAuth`?** `withAuth(credentials, type = 'Bearer')` re-applies `${type} ${credentials}` on every retry attempt, but it captures the credentials *string* at pipe time — fine for a token that outlives the client, stale for one that rotates mid-session. Two ways around that:

```typescript
const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.timeout, 5000);

// (a) Pipe withAuth per request: the argument is evaluated at call time,
//     so the chain always carries the token as it is *right now*.
const listUsers = (page: number) =>
  api
    .pipe(ff.use, ff.withAuth(accessToken))
    .pipe(ff.get, '/users')
    .pipe(ff.query, { page })
    .pipe(ff.fetchJSON<User[]>);

// (b) Rotate between attempts instead of replaying manually: make 401s
//     reject via checkError, then refresh in a createRetryBase callback.
//     Piped first => the retry wrapper sits outside and sees the rejection;
//     the header middleware sits inside, so each attempt re-reads the token.
const refreshBetweenAttempts = ff.createRetryBase(async (attempt, error) => {
  const isStale401 =
    error instanceof ff.HTTPError && error.response.status === 401;
  if (attempt >= 1 || !isStale401) throw error; // rethrowing stops the loop
  await refreshAccessToken();
});

const bearerFromStore: ff.MiddlewareFn = (f) => (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return f(input, { ...init, headers });
};

const apiRotating = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.use, refreshBetweenAttempts) // outer: runs the refresh
  .pipe(ff.use, bearerFromStore) // inner: header rebuilt per attempt
  .pipe(ff.checkError, (res) => {
    if (res.status === 401) throw new ff.HTTPError(res); // 401 now rejects
  });
```

### Nuxt / Vue

`useFetch` and `useAsyncData` own what a *composable* should own: SSR payload serialization, deduplication, and navigation-aware loading state. None of that is transport — and that's the seam where fetch-fun plugs in. Build one shared client in a plugin (base URL from runtime config, auth from your store), then use an executor as the `useAsyncData` handler — the same `queryFn` shape as the TanStack recipe above. Plain-Vue apps with TanStack Vue Query work identically.

```typescript
// plugins/api.ts — one shared client for the whole app
import * as ff from 'fetch-fun';

export default defineNuxtPlugin(() => {
  const auth = useAuthStore();
  const config = useRuntimeConfig();

  // Read the token at request time: the store ref updates during the
  // session, and every request picks up the current value.
  const authed: ff.MiddlewareFn = (f) => (input, init) => {
    const headers = new Headers(init?.headers);
    if (auth.token) headers.set('Authorization', `Bearer ${auth.token}`);
    return f(input, { ...init, headers });
  };

  const api = ff
    .create({ baseUrl: config.public.apiBase })
    .pipe(ff.use, authed)
    .pipe(ff.retry, 2)
    .pipe(ff.timeout, 5000);

  return { provide: { api } };
});
```

```typescript
// pages/users.vue — the composable keeps SSR/caching; the pipe is the fetcher
const { $api } = useNuxtApp();

const { data: users, error } = await useAsyncData('users', () =>
  $api.pipe(ff.get, '/users').pipe(ff.json).pipe(ff.fetchData<User[]>),
);

if (error.value instanceof ff.HTTPError && error.value.response.status === 404) {
  // typed branch: render the empty state instead of an error page
}
```

`useFetch(url)` is the shortcut that hard-wires `$fetch` as the fetcher; when you want fetch-fun's transport (retry, timeout, per-attempt auth), keep the composable and hand it your own handler, as above.

### Next.js (RSC / route handlers)

Server components and route handlers run where `fetch` is Node's built-in (18+) — and since executors call nothing but native `fetch` and `AbortSignal.any`, the exact same pipes you use in the browser work unchanged. Define one client per service in a shared module with the server-side concerns baked in:

```typescript
// lib/api.ts — shared by RSC, route handlers, and server actions
import * as ff from 'fetch-fun';

export const api = ff
  .create({ baseUrl: process.env.API_BASE_URL })
  // server-to-server calls carry a service token, not a user session
  .pipe(ff.use, ff.withAuth(process.env.SERVICE_TOKEN!))
  .pipe(ff.timeout, 5000)
  .pipe(ff.retry, 2);
```

```typescript
// app/users/page.tsx — a React Server Component, no browser in sight
import { api } from '@/lib/api';

export default async function UsersPage() {
  const users = await api
    .pipe(ff.get, '/users')
    .pipe(ff.json)
    .pipe(ff.fetchData<User[]>); // throws HTTPError — catch and branch like anywhere else
  return <UserList users={users} />;
}
```

```typescript
// app/actions.ts — a server action: method sugar + JSON body in one pipe
'use server';

import { api } from '@/lib/api';

export async function renameUser(formData: FormData) {
  await api.pipe(
    ff.patch,
    `/users/${formData.get('id')}`,
    { name: formData.get('name') }, // serialized + Content-Type set
  );
}
```

Route handlers are the same story — `await api.pipe(ff.get, '/health').pipe(ff.fetch)` gives you a `Response` to proxy, transform, or re-wrap. Because the client is just an options object with no platform APIs inside, `lib/api.ts` is also safe to import from client components (drop the service token there, of course).

### Testing with msw / vitest

`fetch(o)` resolves `o.fetch || globalThis.fetch` *per call* — and `setupServer` from msw patches `globalThis.fetch`. Put those two facts together and interception just works: no client wiring, no special test client. Assert what actually went over the wire inside the request handler:

```typescript
// users.test.ts
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import * as ff from 'fetch-fun';

const server = setupServer(
  http.get('https://api.example.com/users', ({ request }) => {
    // assertions on the real outgoing request, not on your mocks of it
    expect(request.headers.get('Authorization')).toBe('Bearer test-token');
    expect(new URL(request.url).searchParams.get('page')).toBe('2');
    return HttpResponse.json([{ id: 1, name: 'Alice' }]);
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('users client', () => {
  it('sends the bearer token and query params', async () => {
    const api = ff
      .create({ baseUrl: 'https://api.example.com' })
      .pipe(ff.use, ff.withAuth('test-token'))
      .pipe(ff.retry, 1);

    const users = await api
      .pipe(ff.get, '/users')
      .pipe(ff.query, { page: 2 })
      .pipe(ff.json)
      .pipe(ff.fetchData<User[]>);

    expect(users).toEqual([{ id: 1, name: 'Alice' }]);
  });

  it('surfaces 4xx as a typed HTTPError with the parsed body', async () => {
    server.use(
      http.get('https://api.example.com/users', () =>
        HttpResponse.json({ message: 'gone' }, { status: 410 }),
      ),
    );

    const err: unknown = await ff
      .create({ baseUrl: 'https://api.example.com' })
      .pipe(ff.get, '/users')
      .pipe(ff.json)
      .pipe(ff.fetchData<User[]>)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ff.HTTPError);
    expect((err as ff.HTTPError).response.status).toBe(410);
    expect((err as ff.HTTPError).data).toEqual({ message: 'gone' });
  });
});
```

When you'd rather not depend on the global patch — scoping one client to one test, counting calls, or coexisting with another library's patching — use the `create({ fetch })` injection point instead:

```typescript
// An explicit wrapper, injected at creation: the client never touches
// the global, so interception is hers, not the environment's.
const calls: string[] = [];
const recordingFetch: typeof globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);
  return globalThis.fetch(input, init);
};

const api = ff.create({
  baseUrl: 'https://api.example.com',
  fetch: recordingFetch,
});
```

### Zod 4 / Valibot: validation with zero adapters

`validate` speaks [Standard Schema v1](https://standardschema.dev/) — it duck-types the `~standard` property on whatever you hand it. Zod 4, Valibot, and ArkType all ship the protocol natively, so the schema object goes straight into the pipe: no adapter package, no `fetch-fun-zod` to install, no wrapping function. (Where other clients tie schema parsing to one specific method or leave it to interceptors and addons, here it's a config fn — composable with any reader and any executor.)

```typescript
import { z } from 'zod'; // Zod 4: Standard Schema v1 built in

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.email(),
});

const user = await api
  .pipe(ff.get, '/users/42')
  .pipe(ff.validate, UserSchema) // the schema itself, nothing else
  .pipe(ff.fetchJSON); // resolves to UserSchema's output type — inferred, no generic
```

```typescript
import * as v from 'valibot'; // Valibot: Standard Schema v1 built in

const UserSchema = v.object({
  id: v.number(),
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
});

const user = await api
  .pipe(ff.get, '/users/42')
  .pipe(ff.validate, UserSchema)
  .pipe(ff.fetchJSON); // same zero-adapter story, different library
```

Validation runs only on 2xx responses, so error bodies stay raw and land untouched on `error.data`; failures throw a `ValidationError` carrying the schema's issues:

```typescript
try {
  await api.pipe(ff.get, '/users/42').pipe(ff.validate, UserSchema).pipe(ff.fetchJSON);
} catch (e) {
  if (e instanceof ff.ValidationError) {
    console.log(e.issues); // [{ message: 'Invalid email', path: ['email'] }, ...]
    console.log(e.data); // the raw parsed body that failed the schema
  }
}
```

## Utilities and Advanced API

| Export | Purpose |
| --- | --- |
| `create(o?)` | Create a client (`Options & Pipe`) from initial options |
| `toFetchParams(o)` | Convert a `Fetchable` to `[url, RequestInit]` (performs the baseUrl join) |
| `applyMiddlewares(f, o)` | Sort and apply a configuration's middlewares to a fetch function |
| `sortMiddlewares(entries)` | Topological sort of middleware entries (outer → inner); throws on duplicates/cycles |
| `normalizeMiddleware(input)` | Normalize a function or config object into a `MiddlewareEntry` |
| `createRetry(maxRetries, opts?)` | Build the smart retry middleware as a bare `MiddlewareFn` |
| `createRetryBase(beforeRetry)` | Build a retry middleware from a fully custom `(attempt, error, o) => Promise<void>` callback (reject to stop) |
| `withRetry` / `withTimeout` / `withAuth` / `withLogging` / `withProgress` | Named + positioned built-in middleware factories (see above) |
| `createQuery(input)` | Typed `URLSearchParams` factory (object / tuple array / string) |
| `NORMAL` | Symbol anchoring the default middleware position |

Commonly used types: `Options`, `Fetchable`, `Client`, `Method`, `Pipe`, `MiddlewareFn`, `MiddlewareInput`, `MiddlewareConfig`, `MiddlewareName`, `QueryType`, `TypedURLSearchParams`, `StandardSchema`, `RetryOptions`, `ProgressOptions`, `ProgressState`, `NetworkError`.

## Versioning

This package follows [semantic versioning](https://semver.org/). Releases and their changelogs are generated automatically by [semantic-release](https://github.com/semantic-release/semantic-release) from [Conventional Commits](https://www.conventionalcommits.org/) — see the [GitHub releases page](https://github.com/wmzy/fetch-fun/releases) for the generated notes.

## Contributing

We welcome contributions to Fetch Fun! If you have any ideas, suggestions, or bug reports, please open an issue on our [GitHub repository](https://github.com/wmzy/fetch-fun/issues).

To contribute code, please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature-branch`).
3. Make your changes and commit them (`git commit -m 'Add new feature'`).
4. Push to the branch (`git push origin feature-branch`).
5. Open a pull request.

Please ensure your code adheres to our coding standards and includes appropriate tests.

## License

This project is licensed under the MIT License.
