# Fetch Fun

[![npm version](https://badge.fury.io/js/fetch-fun.svg)](https://badge.fury.io/js/fetch-fun)
[![Build Status](https://github.com/wmzy/fetch-fun/actions/workflows/ci.yml/badge.svg)](https://github.com/wmzy/fetch-fun/actions)
[![Coverage Status](https://coveralls.io/repos/github/wmzy/fetch-fun/badge.svg?branch=main)](https://coveralls.io/repos/github/wmzy/fetch-fun?branch=main)

A functional fetch toolkit built on one composition protocol: **any function of the shape `(o, ...args) => o'` is an extension point**. Config functions, middlewares, executors, and your own helpers are all just pipeable functions over a plain options object — no class hierarchy, no hidden state, zero runtime dependencies.

## Why fetch-fun (vs ky / ofetch / wretch)

| Dimension | fetch-fun | ky | ofetch | wretch |
| --- | --- | --- | --- | --- |
| API style | Plain pipeable functions over a plain options object (`client.pipe(url, '/x')`) | Options-object instance + hooks | `$fetch(url, options)` wrapper fn | Fluent method chain (`.url().get()`) |
| Extension model | Any `(o, ...args) => o'` function; middlewares with declarative ordering (`outer`/`inner`/`NORMAL`) | `hooks` (beforeRequest/afterResponse) | Request/response interceptors | Middleware chain with index-based placement |
| Type inference | Reader return type flows into `fetchData`; `pipe(validate, schema)` converges to the schema's Standard Schema output; query keys tracked at type level | Generics at call sites | Generics + typed error resolvers | Generics on the chain |
| Error semantics | `fetch` never throws on non-2xx; `fetchData`/`fetchJSON` throw `HTTPError` (`.response`/`.request`/`.data`); typed `TimeoutError` and `ValidationError` | Always throws on non-2xx | `error` object + `onError` | Errors surfaced to `.error()` handlers |
| Schema validation | Built-in, Standard Schema v1 (Zod/Valibot/ArkType, duck-typed, zero adapters) | Bring your own via hooks | Built-in (per-vendor) | Bring your own via middlewares |
| Retry policy | Method-aware (idempotency), status-aware, `Retry-After` honored, exp. backoff + jitter, per-attempt timeout | Basic (status filter) | Retry + interceptor logic | Retry middleware |
| Dependencies | **0** | 0 | Small bundled utility set | 0 |

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
| `query(o, params)` | **Replace** query params | `params`: string / record / tuple array / `URLSearchParams` |
| `mergeQuery(o, params)` | Merge into existing query params | same input as `query` |
| `querySet(o, name, value)` | Set one param (replaces existing value); tracks the key at type level | `name`, `value: string` |
| `queryAppend(o, name, value)` | Append one param (duplicates allowed); repeated keys become arrays at type level | `name`, `value: string` |
| `method(o, m)` | Set the HTTP method | `'GET' \| 'POST' \| ... \| string` |
| `headers(o, h)` | **Replace** all headers | `h: Record<string, string>` |
| `header(o, name, value)` | Set one header (merges) | `name`, `value: string` |
| `auth(o, type, credentials)` | Set `Authorization: ${type} ${credentials}` | `'Basic' \| 'Bearer' \| 'Digest' \| string` |
| `accept(o, mime)` | Set the `Accept` header | `mime: string` |
| `contentType(o, type)` | Set the `Content-Type` header | `type: string` |
| `body(o, data)` | Set a raw string body | `data: string` |
| `jsonBody(o, data)` | `JSON.stringify` the body and set `Content-Type: application/json` | `data: unknown` |
| `signal(o, s)` | Set an `AbortSignal` for cancellation | `s: AbortSignal` |
| `timeout(o, ms)` | Set a **lazy** per-attempt timeout budget (`timeoutMs`) | `ms: number` |
| `retry(o, maxRetries, opts?)` | Add the smart retry middleware | `maxRetries`, [`RetryOptions`](#retry--decision-matrix) |
| `mapResponse(o, mapper)` | Add a middleware mapping `(res, options) => Response` | `mapper` |
| `checkError(o, check)` | Add a middleware that inspects `res` and may throw | `check: (res) => void \| Promise<void>` |
| `data(o, reader)` | Add a response reader; its return value becomes the request's data | `reader: (res) => unknown` |
| `json(o)` | Reader: parse the response body as JSON (does **not** touch request headers) | — |
| `text(o)` | Reader: read the body as text | — |
| `blob(o)` | Reader: read the body as a `Blob` | — |
| `validate(o, schema)` | Attach a Standard Schema v1 schema; parsed data is validated and replaced by its output | `schema: StandardSchema` |
| `use(o, mw)` | Add one middleware (function or `{ name, outer, inner, middleware }` config) | `mw: MiddlewareInput` |
| `middlewares(o, list)` | **Replace** the middleware list | `list: MiddlewareInput[]` |

Notes:

- URL building: `baseUrl` trailing slashes and `url` leading slashes collapse into a single `/`; an absolute `url` (own protocol) bypasses `baseUrl` entirely. `searchParams` are appended with `?` or `&` as needed. A `baseUrl` carrying its own query string is not supported — use `query`/`mergeQuery`.
- `query` accepts anything the `URLSearchParams` constructor accepts. For nested/array serialization, serialize first with your preferred library (`qs`, `query-string`) and pass the string.
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
| Rejected: network error / `TimeoutError` / unknown error | ✅ Yes (retryable methods only) |
| Rejected: `HTTPError` (from your `checkError`) with status in `statuses` | ✅ Yes |
| Rejected: `HTTPError` with status **not** in `statuses` | ❌ No |
| Rejected: `ValidationError` | ❌ No — deterministic, retrying cannot fix it |
| Any outcome, method not in `methods` (default `GET HEAD OPTIONS TRACE PUT DELETE`) | ❌ Never |
| Retries exhausted (`attempt >= maxRetries`) | ❌ Rethrows / returns |

`RetryOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `statuses` | `[408, 425, 429, 500, 502, 503, 504]` | Statuses worth retrying; compared case-insensitively on resolved responses and thrown `HTTPError`s |
| `methods` | `['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']` | Idempotent allowlist; non-listed methods never retry (avoids duplicating side effects) |
| `respectRetryAfter` | `true` | A parseable, non-past `Retry-After` header (integer seconds or HTTP-date) overrides backoff |
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
```

Backoff waits are interruptible by the client's `signal`, and discarded retry responses have their bodies cancelled before the wait.

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
| Timeout / validation errors | Can still throw `TimeoutError`; `ValidationError` on 2xx | Same + `HTTPError` | Same + `HTTPError` |

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

All three classes extend `Error` and are exported from the package root.

| Class | Thrown by | Fields |
| --- | --- | --- |
| `HTTPError` | `fetchData` / `fetchJSON` on `!res.ok` | `response: Response` — the failed response; `request?: Request` — best-effort reconstructed request; `data?: unknown` — parsed error body when a reader (e.g. `json`) already ran |
| `TimeoutError` | The timeout layer when the per-attempt budget elapses | `cause` — the underlying `DOMException`; message includes the budget (`Request timed out after 5000ms`) |
| `ValidationError` | `validate` on failing schema | `issues: readonly unknown[]` — the schema's issues (Zod/Valibot/ArkType objects); `data?: unknown` — the unvalidated data that was rejected |

```typescript
import * as ff from 'fetch-fun';

try {
  await client.pipe(ff.url, '/users/1').pipe(ff.validate, UserSchema).pipe(ff.fetchJSON);
} catch (e) {
  if (e instanceof ff.HTTPError) { /* 4xx/5xx: e.response.status, e.data */ }
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

```typescript
const res = await client
  .pipe(ff.use, ff.withLogging())     // outermost of the NORMAL group
  .pipe(ff.use, ff.withRetry(3))      // 'builtin:retry'
  .pipe(ff.use, ff.withTimeout(5000)) // inner of retry → per-attempt budget
  .pipe(ff.use, ff.withAuth(jwt))     // inner of retry → auth on every attempt
  .pipe(ff.url, '/flaky')
  .pipe(ff.fetch);
```

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
| `withRetry` / `withTimeout` / `withAuth` / `withLogging` | Named + positioned built-in middleware factories (see above) |
| `createQuery(input)` | Typed `URLSearchParams` factory (object / tuple array / string) |
| `NORMAL` | Symbol anchoring the default middleware position |

Commonly used types: `Options`, `Fetchable`, `Client`, `Method`, `Pipe`, `MiddlewareFn`, `MiddlewareInput`, `MiddlewareConfig`, `MiddlewareName`, `QueryType`, `TypedURLSearchParams`, `StandardSchema`, `RetryOptions`.

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
