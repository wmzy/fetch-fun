# OpenAPI-typed clients

Part of the fetch-fun documentation — back to [README](../README.md).

The phantom types don't stop at hand-written URLs. If your API is described by an OpenAPI schema, `openapi-typescript` can turn the spec into pure types, and the [`fetch-fun/openapi`](https://github.com/wmzy/fetch-fun/blob/main/src/openapi.ts) sub-entry grafts them onto the pipe: paths, methods, request bodies, and success-response shapes all become compile-time constraints. Unlike `openapi-fetch` (the dedicated wrapper from the same project), nothing here is a second runtime — the helpers are thin wrappers over the same config functions, so the whole pipe stays in play.

Generate the types from your spec:

```bash
npx openapi-typescript ./openapi.yaml -o ./api-types.d.ts
```

Bind them to the helpers once per spec:

```typescript
import { create, fetchData } from 'fetch-fun';
import { createOpenapi } from 'fetch-fun/openapi';
import type { paths } from './api-types';

const api = create({ baseUrl: 'https://api.example.com' });
const { typedUrl, typedPath, typedQuery, typedMethod, typedJsonBody, typedJson } =
  createOpenapi<paths>();
```

Every step of the chain is now checked against the spec — `fetchData` returns the operation's response type with no type arguments:

```typescript
// GET /users → Promise<User[]> — from paths['/users']['get'].responses[200]
const users = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'get')
  .pipe(typedJson, 'get')
  .pipe(fetchData);

// GET /users/{id} — path template must be a spec key, params must carry
// exactly the template's placeholders; values are encodeURIComponent-ed
const user = await api
  .pipe(typedPath, '/users/{id}', { id: 42 })
  .pipe(typedMethod, 'get')
  .pipe(typedJson, 'get')
  .pipe(fetchData);

// POST /users — body checked against the requestBody schema, response is User
const created = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'post')
  .pipe(typedJsonBody, 'post', { name: 'Ada', email: 'ada@example.com' })
  .pipe(typedJson, 'post')
  .pipe(fetchData);

// The lowercase operation id is optional — omit it on typedJsonBody and
// typedJson and the operation is inferred from the stored method:
const usersNoEcho = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'get')
  .pipe(typedJson)
  .pipe(fetchData); // Promise<User[]> — same inference, no 'get' echo

// Query parameters are constrained by the path item's parameters.query —
// an undeclared key is a compile error, values keep their spec types and
// arrays expand to repeated keys
const page = await api
  .pipe(typedUrl, '/users')
  .pipe(typedQuery, { page: 2, limit: 10, tag: ['a', 'b'] })
  .pipe(typedMethod, 'get')
  .pipe(typedJson)
  .pipe(fetchData); // GET /users?page=2&limit=10&tag=a&tag=b
```

Typos fail loudly: `'/user'` is not a key of `paths`, `'/users/{userId}'` is not either — templates must match the spec verbatim; `'/users' + 'delete'` fails when the path defines no such operation; a params object missing `{ id }`'s key (or carrying extras) is a compile error, and at runtime `fillPath` still throws a `TypeError` if one slips through a type hole; `{ nome: 'Ada' }` doesn't satisfy `UserInput`; a query key the spec doesn't declare under `parameters.query` is a compile error (and a path without query parameters accepts no object at all); and reading the response for `'post'` right after setting the method to `'get'` is a type error — `typedJson` requires the operation id to match the stored method, so the method and the reader can't drift apart.

`typedPath` keeps the template's literal type as the phantom `url` (`'/users/{id}'`, not the filled string), which is what lets the method/body/reader steps keep constraining against `paths[U]` — only the runtime value is the filled, encoded path.

**Types are a promise, not a guarantee.** The spec-derived type only says what the server *should* return. For runtime enforcement, pair the graft with `validate` — write (or generate) a Standard Schema for the same payload and the two layers agree:

```typescript
const UserListSchema = z.array(UserSchema); // Zod, Valibot, ArkType — any vendor

const users = await api
  .pipe(typedUrl, '/users')
  .pipe(typedMethod, 'get')
  .pipe(json)
  .pipe(validate, UserListSchema)
  .pipe(fetchData); // Promise<User[]> — and throws ValidationError if the server lies
```

**Know the edges.** `openapi-typescript` emits types only — zero runtime, the same trade fetch-fun makes — so `allOf` and discriminator unions type-check but aren't verified at runtime (that's the `validate` pairing above). `JsonOk` takes the first 2xx response declaring `application/json` content, in the order 200, 201, 202, 203, 206, 226, `'2XX'` — bodyless `204`/`205` and JSON-less successes resolve to `unknown`, and a spec typing JSON under an exotic code outside that list falls back to `unknown` too (wrap with your own type or a `fetchData` type argument then). `typedQuery` reads the path item's `parameters.query` only — operation-level parameters (declared inside one `get`/`post`) are not consulted; merge them into the path item or use the untyped `query`. And the helpers don't care where the `paths` types came from: generated, hand-written, or adopted one endpoint at a time — `createOpenapi<paths>()` per spec, `JsonBody`/`JsonOk`/`PathKey`/`Op`/`QueryParams` are exported for your own signatures.

**Versus `openapi-fetch`:** it's a purpose-built client with path-param substitution and its own request hooks done for you; this graft is ~1 KB gzip with all dependencies and keeps the whole pipe in play — middleware positioning, retry/timeout, Standard Schema `validate`, injectable fetch. The operation id may be echoed to `typedJsonBody`/`typedJson` (lowercase `m`) to pin the schema lookup, or omitted — the stored method drives the inference.
