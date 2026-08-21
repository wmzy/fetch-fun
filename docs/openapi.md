# OpenAPI-typed clients

Part of the fetch-fun documentation — back to [README](../README.md).

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
