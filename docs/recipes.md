# Recipes: data libraries, auth, testing

Part of the fetch-fun documentation — back to [README](../README.md).

Short, focused recipes for the places fetch-fun usually ends up living: data-fetching libraries, token rotation, meta-frameworks, tests, and schema validation.

## TanStack Query / SWR

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
    // 4xx/5xx with the parsed error body attached (undefined for non-JSON bodies)
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

**Retry and timeout split.** TanStack Query retries the *query* (3 attempts by default, blind exponential backoff); fetch-fun retries the *transport* with method/status awareness, `Retry-After` honoring, and a fresh per-attempt timeout. Pick one layer: pipe `retry` and disable the library's (`retry: false` in TanStack Query, `shouldRetryOnError: false` in SWR), or keep the library defaults and don't pipe `retry` — running both multiplies attempts (a 3-retry query over a 2-retry transport is up to 12 requests per outage). Cancellation composes either way: pipe the `signal` TanStack Query hands your `queryFn` through `ff.signal` so unmounts abort the in-flight request. And whichever layer owns retry, a hard end-to-end deadline is one pipe away: `totalTimeout` puts a single budget over all transport attempts and their backoff ([README](../README.md#totaltimeout--whole-request-budget)).

## 401 → refresh → retry

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

## Nuxt / Vue

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

## Next.js (RSC / route handlers)

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

## Testing with msw / vitest

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

## Zod 4 / Valibot: validation with zero adapters

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

## Streaming responses & Server-Sent Events

SSE used to be the case that pushed you off the data-out executors: `fetchData`'s contract is *buffer, then resolve*, while a live stream wants frames as they arrive. The `events` reader closes that gap. It is the SSE counterpart of `json`/`text` — pipe it and the wire format is handled for you (BOM stripping, `\r\n`/`\r`/`\n` line endings, multi-line `data:` joining, comment keep-alives, `retry:` as a number, even a final frame that never received its closing blank line; the parser lives in `src/events.ts`). `onEvent` receives each frame the moment its blank line lands on the wire, while the promise keeps the buffer-then-resolve contract and settles — to every frame at once — when the stream ends.

```typescript
import * as ff from 'fetch-fun';

const api = ff
  .create({ baseUrl: 'https://api.example.com' })
  .pipe(ff.use, ff.withAuth(token)); // EventSource cannot send headers — fetch can

const frames = await api
  .pipe(ff.get, '/events')
  .pipe(ff.accept, 'text/event-stream')
  .pipe(ff.events, (e: ff.SSEEvent) => console.log(e.event, e.data)) // annotate `e`!
  .pipe(ff.signal, signal) // owns the connect and the stream alike
  .pipe(ff.fetchData); // Promise<SSEEvent[]> — every frame, once the stream ends
```

The annotation on `e` is load-bearing: like `json`'s `parseJson` argument, an unannotated callback makes the generic pipe overload give up, and the `SSEEvent[]` inference on `fetchData` goes with it. Reader semantics apply unchanged otherwise — non-2xx responses throw `HTTPError` (error bodies are framed best-effort onto `error.data`), a `204` resolves to `[]`. For streams that aren't SSE — arbitrary bytes, backpressure-sensitive pipes — the raw `fetch()` executor still hands you the live `Response` body the moment headers land.

The promise settles one connection; subscriptions outlive connections. The loop below owns that half — reconnecting with `Last-Event-ID` so the server can replay what was missed while the wire was down:

```typescript
async function subscribe(
  onEvent: (e: ff.SSEEvent) => void,
  signal: AbortSignal,
) {
  let lastEventId: string | undefined;
  let delay = 1000;

  while (!signal.aborted) {
    try {
      await api
        .pipe(ff.get, '/events')
        .pipe(ff.accept, 'text/event-stream')
        .pipe(ff.headers, lastEventId ? { 'Last-Event-ID': lastEventId } : {})
        .pipe(ff.signal, signal) // one controller owns connects, streams, and gaps
        .pipe(ff.events, (e: ff.SSEEvent) => {
          if (e.id) lastEventId = e.id; // replay point for the next connect
          onEvent(e); // e.retry, when sent, is the server's pacing hint — yours to honor
        })
        .pipe(ff.fetchData); // resolves when the stream ends; a break lands in catch
      delay = 1000; // a stream that ran to completion resets the backoff
    } catch (err) {
      if (signal.aborted) return; // user cancelled, not an outage
      if (err instanceof ff.HTTPError && err.response.status < 500) throw err; // permanent
      // else: the connect failed, or the stream broke mid-body. A mid-body
      // break surfaces as the reader's own rejection — a raw TypeError (network
      // gone) or AbortError DOMException (a signal fired) — fall through and reconnect
    }
    // Cancellable backoff; swap in your favorite jittered scheme
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    delay = Math.min(delay * 2, 15000);
  }
}
```

**Why the reconnect loop is yours, not `retry`'s.** One thing the built-in reader changes: the body is consumed *inside* the middleware chain (the reader is a `data` middleware), so a stream that dies an hour in rejects the very promise `retry` awaits — piped around `events`, retry would reconnect on its own. It would reconnect wrongly, three ways: it re-sends the frozen options, so `Last-Event-ID` is whatever it was when the request was built and every replayed frame dispatches twice (`onEvent` fires again per frame); its budget is a handful of attempts where a subscription wants forever; and pacing is a policy — jittered-exponential-forever, `retry:` hints — not something a transport middleware defaults into. On reconnect, `Last-Event-ID` hands the server the id of the last dispatched event; replaying everything after it is the server's job, so the client keeps no event log. The loop above already bails on permanent 4xx (`HTTPError` from `fetchData`) instead of hammering — the policy decision the old `res.ok` branch used to encode by hand. (Same don't-run-two-layers rule as the TanStack recipe.)

**Timeouts budget connections, not streams.** `timeout` / `totalTimeout` are wall-clock budgets armed when the request executes, and the armed signal stays live after headers arrive: pointed at an SSE endpoint, a 5s budget cuts the stream at 5s. The two differ in what surfaces. `timeout`'s typed-error mapping wraps the raw `fetch()` call and has already exited by the time headers land, so its mid-stream cut surfaces from the reader as a raw `TimeoutError` `DOMException`; `totalTimeout` wraps the whole chain — reader included — so its cut surfaces as the library's typed `TimeoutError`. Either way a budget is the wrong shape for a stream meant to live for hours: hence the example pipes neither, and interrupts with its own `signal`, which cancels the connect, the body, and the backoff wait alike.

**Why not `EventSource`?** It's the platform's SSE client, but it cannot set request headers — no `Authorization` — and its reconnect behavior is not yours to control. The fetch route gets headers and a reconnect loop you own — and with `events` shipping the framing, there is no parser left to hand-roll, so the platform client's one convenience is gone too.

Part of the fetch-fun documentation — back to [README](../README.md).

