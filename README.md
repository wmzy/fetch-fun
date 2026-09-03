# Fetch Fun

[![npm version](https://badge.fury.io/js/fetch-fun.svg)](https://badge.fury.io/js/fetch-fun)
[![Build Status](https://github.com/wmzy/fetch-fun/actions/workflows/ci.yml/badge.svg)](https://github.com/wmzy/fetch-fun/actions)
[![Coverage Status](https://coveralls.io/repos/github/wmzy/fetch-fun/badge.svg?branch=main)](https://coveralls.io/repos/github/wmzy/fetch-fun?branch=main)

A functional fetch toolkit built on one composition protocol: **any function of the shape `(o, ...args) => o'` is an extension point**. Config functions, middlewares, executors, and your own helpers are all just pipeable functions over a plain options object — no class hierarchy, no hidden state, zero runtime dependencies. The small footprint is enforced, not estimated: CI runs size-limit budgets plus a tree-shaking verification, so a typical `create` + `url` + `fetchJSON` + `json` app stays ≈2 kB min+gzip and the full client ≈5 kB.

## Why fetch-fun (vs ky / ofetch / wretch / up-fetch)

| Dimension | fetch-fun | ky / ofetch / wretch / up-fetch |
| --- | --- | --- |
| Composition model | Everything is a plain pipeable function `(o, ...args) => o'` — config functions, executors, and your own helpers alike; middlewares order declaratively (`outer` / `inner` / `NORMAL`) | Instance options + hooks (ky), wrapper fn + interceptors (ofetch), fluent chain + addons (wretch), one builder fn + lifecycle hooks (up-fetch) |
| Tree-shaking | 0 deps, `sideEffects: false`, independent named exports — **enforced by CI** (size-limit + tree-shaking checks): ≈2 kB min+gzip for a typical app, ≈5 kB for the full client | Mostly single-entry units — ky ships retry/hooks/progress with every import, ofetch and up-fetch (~1.6 kB) bundle as one unit; only wretch keeps unused addons out |
| Errors | `fetch` never throws on status; typed `HTTPError` / `NetworkError` / `TimeoutError` / `ValidationError`, all JSON-serializable via `toJSON()`; `mapError` last-hop transformation | The others throw on non-2xx by default with varying escape hatches; typed classes, serialization, and transformation differ per library |
| Type inference | The reader's return type flows into `fetchData`; `validate` converges to the schema's Standard Schema output; query keys tracked at type level | Generics at call sites; schema-output typing in ky and up-fetch |
| Retry & timeouts | Method/status-aware retry with capped `Retry-After` and jittered backoff, lazy per-attempt `timeout`, whole-request `totalTimeout` | Retry with backoff in ky/ofetch/up-fetch (bring-your-own in wretch); total-over-retries timeouts only in ky |
| Built-in extras | SSE reader (`events` + per-frame `onEvent`), upload/download `withProgress`, dynamic auth suppliers (`withAuth(() => token)`) — each opt-in and tree-shaking-isolated | ofetch v2 (alpha) auto-detects event streams; up-fetch has streaming hooks; ky ships progress but no SSE; wretch covers both via addons |

That table is the short version. The full 19-dimension matrix — error serialization, dynamic auth, query serialization, progress models, Node.js baselines, against exact competitor versions (ky 2.0.2, ofetch 1.5.1 / v2 alpha, wretch 3.0.9, up-fetch 2.6.0) — lives in [COMPARISON.md](COMPARISON.md).

## Table of Contents

- [Why fetch-fun](#why-fetch-fun-vs-ky--ofetch--wretch--up-fetch)
  - [Full comparison matrix](COMPARISON.md)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concept: the pipe protocol](#core-concept-the-pipe-protocol)
- [Config Functions Reference](#config-functions-reference)
  - [path — typed placeholder interpolation](#path--typed-placeholder-interpolation)
  - [timeout — lazy, per-attempt budget](#timeout--lazy-per-attempt-budget)
  - [totalTimeout — whole-request budget](#totaltimeout--whole-request-budget)
  - [retry — decision matrix](#retry--decision-matrix)
  - [validate — Standard Schema validation](#validate--standard-schema-validation)
- [Executors: fetch / fetchData / fetchJSON](#executors-fetch--fetchdata--fetchjson)
- [Errors](#errors)
  - [Serializable errors (toJSON)](#serializable-errors-tojson)
  - [mapError — last-hop error transformation](#maperror--last-hop-error-transformation)
- [Middleware and the Positioning System](#middleware-and-the-positioning-system)
- [Type Inference](#type-inference)
- [OpenAPI-typed clients](docs/openapi.md)
- [Recipes: data libraries, auth, testing](docs/recipes.md)
- [Utilities and Advanced API](#utilities-and-advanced-api)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js >= 18 (native `fetch`), or any modern browser. `AbortSignal.any`/`AbortSignal.timeout` (Node.js >= 20.3) are used when present and gracefully fall back to an equivalent manual `AbortController` composition on older runtimes.
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

`json` is overloaded the same way, across the request/response divide:

- the third argument of the method sugar — `post(o, path, json)` — is the **request body**: stringified and sent with a `Content-Type` (`jsonBody` semantics).
- `ff.json(o)` is the **response reader**: it parses the body that comes back.
- `ff.fetchJSON(o)` is the **executor**: it adds the `json` reader itself and resolves the parsed value.

`client.pipe(ff.post, '/users', { name: 'Ada' })` sends JSON; `client.pipe(ff.json)` reads it back. One word, both directions — check which side you are holding.

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
| `path(o, template, params)` | Set the request path by filling `{name}` placeholders in a template — each value `encodeURIComponent`-ed; the template's placeholders become the **required** keys of `params` at the type level | `template: string`, `params: Record<string, string \| number>` |
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
| `totalTimeout(o, ms)` | Set a **lazy** whole-request timeout budget (`totalTimeoutMs`) covering the first attempt, all retries, and backoff waits | `ms: number` |
| `retry(o, maxRetries, opts?)` | Add the smart retry middleware | `maxRetries`, [`RetryOptions`](#retry--decision-matrix) |
| `mapResponse(o, mapper)` | Add a middleware mapping `(res, options) => Response` | `mapper` |
| `checkError(o, check)` | Add a middleware that inspects `res` and may throw | `check: (res) => void \| Promise<void>` |
| `mapError(o, mapper)` | Add a last-hop error mapper — its return value is what `fetchData`/`fetchJSON` throw (see [Errors](#maperror--last-hop-error-transformation)) | `mapper: (e: unknown, ctx: MapErrorContext) => unknown` |
| `data(o, reader)` | Add a response reader; its return value becomes the request's data | `reader: (res) => unknown` |
| `json(o, parseJson?)` | Reader: parse the response body as JSON (does **not** touch request headers); an empty body (`204`/`205`/`HEAD`, …) resolves `undefined` — `parseJson` is never called for empty bodies | `parseJson?: (raw: string) => unknown` — custom parser, e.g. `JSON.parse` with a reviver to revive `Date`s; its return type flows into `fetchData`'s inference |
| `text(o)` | Reader: read the body as text | — |
| `blob(o)` | Reader: read the body as a `Blob` | — |
| `arrayBuffer(o)` | Reader: read the body as an `ArrayBuffer` | — |
| `formData(o)` | Reader: read the body as a `FormData` | — |
| `events(o, onEvent?)` | Reader: parse the body as a Server-Sent Events stream — each frame is passed to `onEvent` the moment its terminating blank line arrives, and `fetchData` resolves to the complete `SSEEvent[]` once the stream ends. Full wire-format framing: leading BOM, `\r\n`/`\r`/`\n` line endings, `:` comments, multi-line `data:` (joined with `\n`), `id:`, numeric `retry:`, and a trailing frame missing its blank line. Non-2xx responses still throw `HTTPError`; reconnection policy stays with you (see [docs/recipes.md](docs/recipes.md) for the Last-Event-ID loop) | `onEvent?: (e: SSEEvent) => void` — annotate the parameter (`(e: SSEEvent) => …`), as with `json`'s parser, so the generic pipe overload applies |
| `validate(o, schema)` | Attach a Standard Schema v1 schema; parsed data is validated and replaced by its output | `schema: StandardSchema` |
| `use(o, mw)` | Add one middleware (function or `{ name, outer, inner, middleware }` config) | `mw: MiddlewareInput` |
| `middlewares(o, list)` | **Replace** the middleware list | `list: MiddlewareInput[]` |

Notes:

- URL building: `baseUrl` trailing slashes and `url` leading slashes collapse into a single `/`; an absolute `url` (own protocol) bypasses `baseUrl` entirely, and so does a protocol-relative `url` (`//cdn.example.com/x`) — it inherits the caller's protocol and is passed through untouched. `../` segments are kept verbatim in the join: there is no client-side URL resolution, the server sees and resolves them. `searchParams` are appended with `?` or `&` as needed. A `baseUrl` carrying its own query string is not supported — use `query`/`mergeQuery`.
- `query` accepts anything the `URLSearchParams` constructor accepts, with `number`/`boolean` values stringified along the way (`{ page: 1 }` → `?page=1`). For nested/array serialization, serialize first with your preferred library (`qs`, `query-string`) and pass the string.
- `json()` only configures **response** parsing; it no longer sets a request `Content-Type`. To send JSON use `jsonBody`, or set headers explicitly with `contentType`/`header`.

### path — typed placeholder interpolation

`path(o, template, params)` is `url` for templated routes: it fills every `{name}` placeholder in the template with `encodeURIComponent(params[name])` and sets the result as the `url` — replacing any previous one and joining with `baseUrl` at fetch time exactly like a plain `url` call. Because values are encoded, a param can never inject `/`, `?`, or `#` and escape its path segment.

The template is checked at compile time: its placeholders become the **required** keys of `params` — a missing key is a compile error, and an object literal with extra keys is rejected by excess property checking — so `'/articles/{slug}'` accepts exactly `{ slug }` and nothing else.

```typescript
const article = await client
  .pipe(ff.path, '/articles/{slug}', { slug }) // '/articles/hello-world'
  .pipe(ff.fetchJSON<Article>);

// values are URL-encoded, so they stay inside their segment
client.pipe(ff.path, '/files/{name}', { name: 'my report.pdf' });
// url becomes '/files/my%20report.pdf'
```

At runtime a missing or `undefined` param throws a `TypeError` naming the template and the missing parameter(s). Like every config function, the fill happens at pipe time — the error surfaces before any request is attempted.

`path` composes with the rest of the URL toolkit: `baseUrl` joins underneath, `appendUrl` appends segments after the fill, and the query functions append after that:

```typescript
const posts = await client // baseUrl: 'https://api.example.com'
  .pipe(ff.path, '/users/{id}', { id: userId })
  .pipe(ff.appendUrl, '/posts')
  .pipe(ff.querySet, 'page', 2)
  .pipe(ff.fetchJSON<Post[]>);
// GET https://api.example.com/users/42/posts?page=2
```

The standalone helper `fillPath(template, params): string` performs the same fill outside a pipe — handy for cache keys, router paths, or pre-building a `url()`:

```typescript
fillPath('/articles/{slug}', { slug: '你好 世界' });
// '/articles/%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C'
```

### timeout — lazy, per-attempt budget

`timeout(o, ms)` only stores `timeoutMs` on the options — no timer starts until the request executes. Each attempt (including every retry attempt) then gets a **fresh** timeout signal, combined with your `signal` via `AbortSignal.any` (or an equivalent manual composition on runtimes predating it). Piping `timeout` is side-effect free, so a reused client always gets a full budget; a later `timeout` pipe overwrites an earlier one.

```typescript
// Each attempt of each request gets 5 seconds, counted from its own start
const res = await client
  .pipe(ff.url, '/slow')
  .pipe(ff.timeout, 5000)
  .pipe(ff.retry, 2)
  .pipe(ff.fetch);
```

A timeout abort is rethrown as `ff.TimeoutError` with the underlying `DOMException` as `cause`; user-initiated aborts (`AbortError`) propagate unchanged.

### totalTimeout — whole-request budget

`totalTimeout(o, ms)` stores `totalTimeoutMs` — lazily again: no timer starts until the request executes, and a later `totalTimeout` pipe overwrites an earlier one. At execution time a single `AbortSignal.timeout(ms)` wraps the fully applied middleware chain, outside retry, so the one budget covers the first attempt, every retry, and the backoff waits in between. When it elapses, the in-flight attempt is aborted and the request rejects with `ff.TimeoutError` carrying the budget (`Request timed out after 10000ms`); aborting through your own `signal` still propagates as the native `AbortError`.

`totalTimeout` and per-attempt `timeout` compose independently — the outer total bounds the whole sequence, the inner budget bounds each attempt:

```typescript
// The whole request — 3 attempts and the backoff between them — must
// finish within 10s; any single attempt that stalls for 3s fails faster
// and lets retry start sooner.
const res = await client
  .pipe(ff.url, '/flaky')
  .pipe(ff.timeout, 3000)       // per-attempt: a fresh 3s budget on every try
  .pipe(ff.retry, 2)            // up to 3 attempts with backoff in between
  .pipe(ff.totalTimeout, 10000) // whole-request: one 10s budget over it all
  .pipe(ff.fetch);
```

This mirrors ky's `totalTimeout` option — a deadline over retries rather than per attempt — except here it is one more pipeable config function rather than an option flag.

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
| `respectRetryAfter` | `true` | A parseable, non-past `Retry-After` header (integer seconds or HTTP-date) overrides backoff — consulted on the discarded response and on a thrown `HTTPError`'s response (e.g. from your `checkError`) alike |
| `maxRetryAfter` | `30000` | Upper bound (ms) for waits honored from `Retry-After`; a server demanding more is clamped down to it — the retry still happens, just sooner. Only relevant when `respectRetryAfter` is true |
| `shouldRetry` | — (built-in decisions) | Custom predicate `(attempt, { response? \| error? }) => boolean \| Promise<boolean>` that fully replaces the built-in retry decisions (see note above); `attempt` is 0-indexed |
| `beforeRetry` | — (none) | Hook `({ attempt, error?, request?, response? }) => RequestInit \| false \| void \| Promise<...>` run right before each retry attempt — after the gates decided a retry is worth it, before the backoff wait. Return a `RequestInit` patch to rewrite the next attempt (`headers` merge per name with the patch winning, other fields replace), `false` to give up and surface the failed outcome as-is, or nothing to retry unchanged. Async hooks are awaited. `error` is the rejection when the attempt threw; `response` is the failed response when one exists (the resolved retryable response, or a thrown `HTTPError`'s response — body still readable); `request` is a best-effort reconstructed `Request` |
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

**401 → refresh the token → replay** is one `beforeRetry` hook — no custom middleware. The hook runs after retry decided the 401 is worth another attempt, awaits your async refresh, and its returned `RequestInit` patch becomes the replayed request (headers merge per name, so swapping `Authorization` keeps `Content-Type` and friends):

```typescript
import * as ff from 'fetch-fun';

let accessToken = await signIn(); // e.g. 'Bearer eyJhbGci...'

const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.header, 'Authorization', `Bearer ${accessToken}`) // whatever signIn gave
  .pipe(ff.retry, 1, {
    statuses: [401, 429, 503], // the token-expiry 401 is retryable
    delay: { initial: 250 },
    beforeRetry: async ({ attempt, error, request, response }) => {
      // Only the token-expiry path needs new credentials; everything else
      // (429/503) just retries with the original request untouched.
      if (response?.status !== 401) return; // void → retry unchanged
      accessToken = await refreshAccessToken(); // POST /oauth/token, awaited
      // The patch is merged into the next attempt: the replay goes out
      // with the fresh token while the rest of the headers survive.
      return { headers: { Authorization: `Bearer ${accessToken}` } };
      // return false;  // ← instead: give up, surface the 401 as-is
    },
  });

// First try: 401 → beforeRetry refreshes → replay: 200
const me = await api.pipe(ff.url, '/me').pipe(ff.fetchJSON);
```

The hook also fires for rejections (a `checkError` that threw `HTTPError`) — then `error` is the thrown error and `response` the `HTTPError`'s response. Returning `false` stops the loop: the failed response is returned with its body intact, or the original error rethrown — exactly as an exhausted budget would surface it. The hook is never consulted when no retry would happen anyway (non-retryable method/status, `ValidationError`, exhausted `maxRetries`).

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
| Reader needed | No | Yes — configure `json` / `text` / `blob` / `events` / `data` first | No — `fetchJSON` adds the `json` reader itself |
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

One `no-cors` caveat: such requests resolve to opaque responses (`type: 'opaque'`, `status: 0`, `ok: false`). `fetchData`/`fetchJSON` deliberately do **not** throw `HTTPError` for them (matching ky 2.0) — the response is handed to your reader, and any failure to read the by-design-unreadable opaque body surfaces naturally from the reader instead. For `no-cors` requests, consider the raw `fetch()` escape hatch and inspect the response yourself.

## Errors

All four classes extend `Error` and are exported from the package root.

| Class | Thrown by | Fields |
| --- | --- | --- |
| `HTTPError` | `fetchData` / `fetchJSON` on `!res.ok` | `response: Response` — the failed response; `status: number` — shorthand for `response.status`; `request?: Request` — best-effort reconstructed request; `data?: unknown` — parsed error body when a reader (e.g. `json`) already ran; a non-2xx body the reader cannot parse (an HTML error page under `json`) resolves to `undefined`, so the `HTTPError` is still what you catch — never the reader's `SyntaxError`; `withMessage(msg)` — clone with the message replaced: created with the original as its prototype, so it inherits every field — `response`/`request`/`data`/`cause` plus anything a subclass or caller attached later — and keeps the `HTTPError` identity; the clone shares the original's `stack` instead of capturing a fresh one |
| `NetworkError` | The innermost wrapper around the base fetch, when fetch itself rejects with a `TypeError` (DNS failure, connection refused, TLS error, offline) | `url?: string` — best-effort URL of the failed request; `cause` — the original `TypeError`; message reads like `GET https://api.example.com/x failed: network error` |
| `TimeoutError` | The timeout layers — per-attempt `timeout` or whole-request `totalTimeout` — when the budget elapses | `cause` — the underlying `DOMException`; message includes the budget (`Request timed out after 5000ms`) |
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

### Serializable errors (toJSON)

All four error classes implement `toJSON()`, so `JSON.stringify(err)` emits a plain, meaningful object instead of `{}` — the shape survives any JSON boundary: SSR → client hydration, web worker → main thread, `postMessage`, test snapshots. No live `Response`/`Request` reference is carried across:

```typescript
// catch (e) — any of the four classes
JSON.stringify(e);
// HTTPError       → { name, message, status, url, data }
// NetworkError    → { name, message, url?, cause?: { name, message } }
// TimeoutError    → { name, message, cause?: { name, message } }
// ValidationError → { name, message, issues, data }
```

On the receiving side, branch on the `name` field (`'HTTPError'` | `'NetworkError'` | `'TimeoutError'` | `'ValidationError'`). An `Error` cause is reduced to `{ name, message }`; anything else is dropped (`undefined`) so the object always serializes.

### mapError — last-hop error transformation

`mapError(o, mapper)` attaches an error mapper that runs as the very last hop before `fetchData`/`fetchJSON` throw to your code — the counterpart of ky's `beforeError` and up-fetch's `parseRejected`:

```typescript
class NotFoundError extends Error {
  constructor(readonly response: Response, cause: unknown) {
    super(`Not found: ${response.url}`, { cause });
  }
}

const user = await client
  .pipe(ff.url, '/users/42')
  .pipe(ff.mapError, (e, ctx) =>
    ctx.response?.status === 404 ? new NotFoundError(ctx.response, e) : e,
  )
  .pipe(ff.fetchJSON);
```

The mapper has the shape `(e: unknown, ctx: MapErrorContext) => unknown`, where `MapErrorContext` (`{ response?: Response; request?: Request }`) is populated only when the error is an `HTTPError` — the failed `response` plus the best-effort reconstructed `request`; every other error type (network, timeout, validation, user middleware) gets `{}`.

The most common mapping — rewrite the message from the parsed error body — is one line with `HTTPError.withMessage`: the clone is created with the original as its prototype — it inherits every field (`response`, `request`, `data`, `cause`, and anything a subclass or middleware attached after construction) and keeps the `HTTPError` identity, so downstream `instanceof` checks, `.status`, and `.data` all keep working (a global 401 → logout handler can still branch on `e.status`); the clone shares the original's `stack` rather than capturing a fresh one:

```typescript
const user = await client
  .pipe(ff.url, '/users/42')
  .pipe(ff.mapError, (e) =>
    e instanceof ff.HTTPError ? e.withMessage(errorText(e.data)) : e,
  )
  .pipe(ff.fetchJSON);
```

Key semantics:

- **Every error type passes through** — `HTTPError`, `NetworkError`, `TimeoutError`, `ValidationError`, and errors thrown by user middlewares alike. The mapper's return value is thrown as-is; async mappers are awaited.
- **`undefined` passes the original through** — a mapper that returns `undefined` (e.g. a branch that found nothing to map) rejects with the original error, never with `undefined` itself.
- **A failing mapper never swallows the original** — if the mapper itself throws, its own error surfaces with the original attached as `cause` (an `Error` without one gains it; a non-`Error` thrown value is wrapped in an `Error` whose `cause` carries both).
- **`retry` sees the original error** — the mapper runs after the whole middleware chain (including retry) has settled, so retry decisions are made on the unmapped error; only the finally thrown value is mapped.
- **Piping `mapError` again replaces** the previous mapper — the same overwrite semantics as `timeout`.
- **Only `fetchData`/`fetchJSON` map** — the raw `fetch()` escape hatch bypasses the mapper entirely and rejects with the original error.

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
| `withAuth(credentials, type?)` | `builtin:auth` | `inner` of `builtin:retry` — each attempt (re)applies the `Authorization` header; `credentials` may be a string or a supplier `() => string \| null \| undefined \| Promise<...>` re-evaluated on every attempt; empty results (`''` / `null` / `undefined` / whitespace) skip the header and drop any inherited `Authorization` |
| `withLogging(logger?)` | `builtin:logging` | `outer` of `NORMAL` — logs request/response/error with duration |
| `withProgress(opts?)` | `builtin:progress` | `inner` of `NORMAL` — inside the default group (and therefore inside retry): every (re)try reports its own progress from zero |

```typescript
const res = await client
  .pipe(ff.use, ff.withLogging())     // outermost of the NORMAL group
  .pipe(ff.use, ff.withRetry(3))      // 'builtin:retry'
  .pipe(ff.use, ff.withTimeout(5000)) // inner of retry → per-attempt budget
  .pipe(ff.use, ff.withAuth(() => tokenStore.get())) // inner of retry → token re-read per attempt
  .pipe(ff.url, '/flaky')
  .pipe(ff.fetch);
```

`withAuth` also accepts a **token supplier** in place of a static string: `withAuth(() => store.getToken())`, or an async `withAuth(async () => await refreshJwt())`. The supplier is awaited once per request — and again on every retry attempt — so rotated or refreshed tokens are picked up without writing a custom middleware. As with the config-side `auth(o, type, credentials)`, the header value is the literal `${type} ${credentials}` with no extra encoding (pass pre-encoded base64 for `Basic`). A supplier that returns an empty value (`''`, `null`, `undefined`, or whitespace) sends no `Authorization` header at all — an inherited default (e.g. a stale token set via `header()` on a shared client) is deleted, so a logged-out supplier can simply `return token ?? undefined`.

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

Null-body responses (`204`/`205`/`HEAD`, …) are returned untouched and produce no callbacks. `onUploadProgress` fires out of the box only when the request `init.body` is a `ReadableStream` — every other body shape passes through uncounted rather than being serialized just to count it; a stream's length is unknown, so `total` is `0` there. Opt in with `wrapBody: true` to observe the other shapes too: `string`, `Blob`, `ArrayBuffer`, `ArrayBufferView`, and `URLSearchParams` bodies are wrapped into a counting stream, so `total` becomes the body's real byte size and `percent` turns meaningful. Because a stream body loses the implicit `Content-Type` that native `fetch` would have set, the defaults for `string` (`text/plain;charset=UTF-8`) and `URLSearchParams` (`application/x-www-form-urlencoded;charset=UTF-8`) are restored — only when the request headers set no `Content-Type` explicitly — and `duplex: 'half'` is set automatically, never overriding a caller-provided value. `FormData` is never wrapped (it cannot be sized without serializing it), and a bare `ReadableStream` keeps the counting path above with `total: 0` — for it, native `fetch` requires `duplex: 'half'`, which callers set themselves.

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

Grafting `openapi-typescript`'s generated `paths` types onto the pipe — typed paths (with `{param}` template substitution), methods, request bodies, and success-response shapes via the `fetch-fun/openapi` sub-entry (`createOpenapi<paths>()` binding `typedUrl`/`typedPath`/`typedMethod`/`typedJsonBody`/`typedJson`, ~1 KB gzip) — now lives in [docs/openapi.md](docs/openapi.md), including the comparison with `openapi-fetch`.

## Recipes: data libraries, auth, testing

Short, focused recipes — TanStack Query / SWR, 401 → refresh → retry, Nuxt / Vue, Next.js RSC, msw / vitest testing, Zod 4 / Valibot validation, and streaming responses / Server-Sent Events — now live in [docs/recipes.md](docs/recipes.md).

### The SPA default: timeout + retry + auth

Every SPA wants the same three protections, and they are two pipes away — no aggregate `spa()` factory needed, the defaults are already right:

```typescript
const client = ff
  .create({ baseUrl })
  .pipe(ff.use, ff.withTimeout(10000)) // per-attempt budget; each retry gets a fresh one
  .pipe(ff.use, ff.withRetry(2));      // default retries idempotent methods on transient statuses (408/425/429/500/502/503/504)
```

Why these defaults fit a browser app:

- **`withTimeout`** — without a budget a request on a flaky network hangs forever; with a blocking router loader that is a frozen page whose only escape is canceling the navigation. `withTimeout(10000)` rejects with `ff.TimeoutError` after 10 s, every attempt.
- **`withRetry(2)`** — retries at most twice, and only what is safe: idempotent methods (`GET`/`HEAD`/`PUT`/`DELETE`/`OPTIONS`/`TRACE`) failing transiently (`408`/`425`/`429`/`500`/`502`/`503`/`504`, network errors, `TimeoutError`). A `POST` or a `404` never replays. Tune with `ff.withRetry(2, { methods: ['GET', 'HEAD'], ... })`.
- **`withAuth`** — add it on the same client for token injection: `ff.withAuth(() => tokenStore.token, 'Bearer')`. The supplier re-runs on every attempt, and an empty token sends no `Authorization` header at all (logged-out requests stay anonymous).
- **Cancellation stays yours** — `Options` is a `RequestInit` superset, so a per-call `signal` goes straight through: `client.pipe(ff.get, '/x').pipe(ff.signal, abortController.signal)`. Timeout, retry, and your signal compose via `AbortSignal.any`.

## Utilities and Advanced API

| Export | Purpose |
| --- | --- |
| `create(o?)` | Create a client (`Options & Pipe`) from initial options |
| `toFetchParams(o)` | Convert a `Fetchable` to `[url, RequestInit]` (performs the baseUrl join); keys that are neither fetch-fun options nor `RequestInit` fields pass through to fetch silently — in development each one logs a `console.warn` naming it (silent in production) |
| `applyMiddlewares(f, o)` | Sort and apply a configuration's middlewares to a fetch function |
| `sortMiddlewares(entries)` | Topological sort of middleware entries (outer → inner); throws on duplicates/cycles |
| `normalizeMiddleware(input)` | Normalize a function or config object into a `MiddlewareEntry` |
| `createRetry(maxRetries, opts?)` | Build the smart retry middleware as a bare `MiddlewareFn` |
| `createRetryBase(beforeRetry)` | Build a retry middleware from a fully custom `(attempt, error, o) => Promise<void>` callback (reject to stop) |
| `withRetry` / `withTimeout` / `withAuth` / `withLogging` / `withProgress` | Named + positioned built-in middleware factories (see above) |
| `createQuery(input)` | Typed `URLSearchParams` factory (object / tuple array / string) |
| `fillPath(template, params)` | Fill `{name}` placeholders in a path template, `encodeURIComponent`-ing each value; throws `TypeError` on missing/`undefined` params. `path()` uses it internally; params are typed via `PlaceholderParams<T>` |
| `NORMAL` | Symbol anchoring the default middleware position |

Commonly used types: `Options`, `Fetchable`, `Client`, `Method`, `Pipe`, `MiddlewareFn`, `MiddlewareInput`, `MiddlewareConfig`, `MiddlewareName`, `QueryType`, `TypedURLSearchParams`, `PlaceholderParams`, `StandardSchema`, `RetryOptions`, `MapErrorContext`, `ProgressOptions`, `ProgressState`, `NetworkError`, `SSEEvent` (a parsed SSE frame: `{ event, data, id?, retry? }`).

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
