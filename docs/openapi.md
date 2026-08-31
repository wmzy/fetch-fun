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
const { typedUrl, typedPath, typedMethod, typedJsonBody, typedJson } =
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
```

Typos fail loudly: `'/user'` is not a key of `paths`, `'/users/{userId}'` is not either — templates must match the spec verbatim; `'/users' + 'delete'` fails when the path defines no such operation; a params object missing `{ id }`'s key (or carrying extras) is a compile error, and at runtime `fillPath` still throws a `TypeError` if one slips through a type hole; `{ nome: 'Ada' }` doesn't satisfy `UserInput`; and reading the response for `'post'` right after setting the method to `'get'` is a type error — `typedJson` requires `method: Uppercase<M>`, so the method and the reader can't drift apart.

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

**Know the edges.** `openapi-typescript` emits types only — zero runtime, the same trade fetch-fun makes — so `allOf` and discriminator unions type-check but aren't verified at runtime (that's the `validate` pairing above). `JsonOk` covers the 200 response first, then 201 as fallback — extend the chain in your own wrapper if your spec leans on other status codes. Query parameters stay plain: pipe `query`/`querySet` as usual (the operation's `parameters.query` type is there in `paths` if you want to pin it yourself). And the helpers don't care where the `paths` types came from: generated, hand-written, or adopted one endpoint at a time — `createOpenapi<paths>()` per spec, `JsonBody`/`JsonOk`/`PathKey`/`Op` are exported for your own signatures.

**Versus `openapi-fetch`:** it's a purpose-built client with path-param substitution and its own request hooks done for you; this graft is ~1 KB gzip with all dependencies and keeps the whole pipe in play — middleware positioning, retry/timeout, Standard Schema `validate`, injectable fetch — at the cost of passing the operation id to `typedJsonBody`/`typedJson` (lowercase `m`) so the schemas can be looked up.
