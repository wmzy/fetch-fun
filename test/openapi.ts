import type { JsonBody, JsonOk } from '@/openapi';

import { describe, it, expect, vi, expectTypeOf } from 'vitest';

import { create, fetchData, fetch as doFetch } from '@/index';
import { createOpenapi } from '@/openapi';

/** Fixture entity — the schema half of the fake spec below. */
type User = {
  id: number;
  name: string;
}

/**
 * Fixture `paths` mirroring openapi-typescript's output shape: literal
 * path keys (templates verbatim), a `parameters` key that `Op` must
 * exclude, a 201-only success (POST /users), a JSON-less 204, a
 * 202-only success (GET /jobs), a multi-2xx endpoint (POST /uploads),
 * and path-item query parameters (GET /users).
 */
type paths = {
  '/users': {
    parameters: { query: { page?: number; limit?: number; tag?: string[] } };
    get: {
      responses: { 200: { content: { 'application/json': User[] } } };
    };
    post: {
      requestBody: { content: { 'application/json': { name: string } } };
      responses: { 201: { content: { 'application/json': User } } };
    };
  };
  '/users/{id}': {
    parameters: { path: { id: number } };
    get: {
      responses: { 200: { content: { 'application/json': User } } };
    };
    delete: {
      responses: { 204: { content: object } };
    };
  };
  '/jobs': {
    get: {
      responses: { 202: { content: { 'application/json': { queued: boolean } } } };
    };
  };
  '/uploads': {
    post: {
      responses: {
        200: { content: { 'application/json': { id: string } } };
        202: { content: { 'application/json': { pending: true } } };
      };
    };
  };
}

const { typedUrl, typedPath, typedQuery, typedMethod, typedJsonBody, typedJson } =
  createOpenapi<paths>();

describe('openapi typedUrl', function () {
  it('stores a spec path as the url option', function () {
    typedUrl({ baseUrl: 'https://api.example.com' }, '/users').should.be.eql({
      baseUrl: 'https://api.example.com',
      url: '/users',
    });
  });

  it('keeps the literal path type for the next pipe step', function () {
    expectTypeOf(typedUrl(create(), '/users').url).toEqualTypeOf<'/users'>();
  });
});

describe('openapi typedPath', function () {
  it('fills and encodes path parameters from a spec template', function () {
    typedPath({}, '/users/{id}', { id: 'a/b c' }).should.be.eql({
      url: '/users/a%2Fb%20c',
    });
  });

  it('keeps the template literal type, not the widened string', function () {
    expectTypeOf(typedPath({}, '/users/{id}', { id: 1 }).url).toEqualTypeOf<
      '/users/{id}'
    >();
  });

  it('propagates the fill error when a param slips through at runtime', function () {
    expect(() =>
      typedPath({}, '/users/{id}', {} as { id: string | number })
    ).toThrow(TypeError);
  });
});

describe('openapi typedQuery', function () {
  it('stores spec query parameters as searchParams, stringifying values', function () {
    const o = typedQuery(typedUrl({ baseUrl: 'https://api.example.com' }, '/users'), {
      page: 2,
      limit: 10,
    });
    o.should.be.eql({
      baseUrl: 'https://api.example.com',
      url: '/users',
      searchParams: new URLSearchParams('page=2&limit=10'),
    });
  });

  it('expands array values into repeated keys', function () {
    const o = typedQuery(typedUrl({}, '/users'), {
      tag: ['a', 'b'],
    } as { tag?: string[] });
    o.searchParams!.getAll('tag').should.be.eql(['a', 'b']);
  });

  it('skips omitted and undefined entries', function () {
    const o = typedQuery(typedUrl({}, '/users'), {
      page: 1,
      limit: undefined,
    } as { page?: number; limit?: number });
    o.searchParams!.toString().should.be.equal('page=1');
  });

  it('rejects keys the spec does not declare', function () {
    // @ts-expect-error 'pagee' is not a query parameter of /users
    typedQuery(typedUrl({}, '/users'), { pagee: 1 });
    // A path without query parameters accepts no object at all.
    // @ts-expect-error /users/{id} declares path parameters only
    typedQuery(typedUrl({}, '/users/{id}'), { id: 1 });
  });

  it('end-to-end: appends the query string to the request URL', async function () {
    const mockFetch = vi.fn().mockResolvedValue(new Response('[]'));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    await client
      .pipe(typedUrl, '/users')
      .pipe(typedQuery, { page: 3, limit: 5, tag: ['x', 'y'] })
      .pipe(typedMethod, 'get')
      .pipe(typedJson, 'get')
      .pipe(fetchData);

    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://api.example.com/users?page=3&limit=5&tag=x&tag=y'
    );
  });
});

describe('openapi typedMethod', function () {
  it('stores the uppercase method', function () {
    const o = typedMethod(typedUrl({}, '/users'), 'get');
    o.should.be.eql({ url: '/users', method: 'GET' });
    expectTypeOf(o.method).toEqualTypeOf<'GET'>();
  });
});

describe('openapi typedJsonBody', function () {
  it('stores a JSON body and Content-Type header', function () {
    const o = typedJsonBody(
      typedMethod(typedUrl({}, '/users'), 'post'),
      'post',
      { name: 'Ada' }
    );
    o.should.be.eql({
      url: '/users',
      method: 'POST',
      body: '{"name":"Ada"}',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('checks the body without echoing the operation id', function () {
    // The operation is inferred from the method phantom type; the body is
    // still validated against that operation's requestBody schema.
    const o = typedJsonBody(typedMethod(typedUrl({}, '/users'), 'post'), {
      name: 'Ada',
    });
    o.should.be.eql({
      url: '/users',
      method: 'POST',
      body: '{"name":"Ada"}',
      headers: { 'Content-Type': 'application/json' },
    });
    // ...and a body that misses the schema still fails to compile.
    typedJsonBody(typedMethod(typedUrl({}, '/users'), 'post'), {
      // @ts-expect-error '{ nome }' misses 'name'
      nome: 'Ada',
    });
  });
});

describe('openapi typedJson end-to-end', function () {
  it('reads a templated GET as the 200 response type', async function () {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('{"id":1,"name":"Ada"}'));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const user = await client
      .pipe(typedPath, '/users/{id}', { id: 42 })
      .pipe(typedMethod, 'get')
      .pipe(typedJson, 'get')
      .pipe(fetchData);

    expect(user).toEqual({ id: 1, name: 'Ada' });
    expect(mockFetch.mock.calls[0]![0]).toBe('https://api.example.com/users/42');
    expectTypeOf(user).toEqualTypeOf<User>();
  });

  it('checks the body against the schema and reads the 201 response', async function () {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('{"id":7,"name":"Ada"}', { status: 201 }));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const created = await client
      .pipe(typedUrl, '/users')
      .pipe(typedMethod, 'post')
      .pipe(typedJsonBody, 'post', { name: 'Ada' })
      .pipe(typedJson, 'post')
      .pipe(fetchData);

    expect(created).toEqual({ id: 7, name: 'Ada' });
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: '{"name":"Ada"}',
    });
    expectTypeOf(created).toEqualTypeOf<User>();
  });

  it('resolves a JSON-less success response to unknown/undefined', async function () {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const gone = await client
      .pipe(typedUrl, '/users/{id}')
      .pipe(typedMethod, 'delete')
      .pipe(typedJson, 'delete')
      .pipe(fetchData);

    expect(gone).toBeUndefined();
    expectTypeOf(gone).toEqualTypeOf<unknown>();
  });

  it('reads a 202 success as its JSON payload (2xx beyond 200/201)', async function () {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"queued":true}', {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const job = await client
      .pipe(typedUrl, '/jobs')
      .pipe(typedMethod, 'get')
      .pipe(typedJson, 'get')
      .pipe(fetchData);

    expect(job).toEqual({ queued: true });
    expectTypeOf(job).toEqualTypeOf<{ queued: boolean }>();
  });

  it('reads the success schema without echoing the operation id', async function () {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('[{"id":1,"name":"Ada"}]'))
      .mockResolvedValueOnce(
        new Response('{"id":1,"name":"Ada"}', { status: 201 })
      );
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    // No 'get' echo on the reader, no 'post' echo on the body below —
    // the operation comes from the method phantom type.
    const users = await client
      .pipe(typedUrl, '/users')
      .pipe(typedMethod, 'get')
      .pipe(typedJson)
      .pipe(fetchData);
    expect(users).toEqual([{ id: 1, name: 'Ada' }]);
    expectTypeOf(users).toEqualTypeOf<User[]>();

    const created = await client
      .pipe(typedUrl, '/users')
      .pipe(typedMethod, 'post')
      .pipe(typedJsonBody, { name: 'Ada' })
      .pipe(typedJson)
      .pipe(fetchData);
    expect(created).toEqual({ id: 1, name: 'Ada' });
    expectTypeOf(created).toEqualTypeOf<User>();
  });
});

describe('openapi types', function () {
  it('resolves body and response schemas through the exported helpers', function () {
    expectTypeOf<
      JsonBody<paths['/users']['post']>
    >().toEqualTypeOf<{ name: string }>();
    expectTypeOf<JsonOk<paths['/users']['post']>>().toEqualTypeOf<User>();
    expectTypeOf<JsonOk<paths['/users/{id}']['delete']>>().toEqualTypeOf<
      unknown
    >();
  });

  it('resolves JSON success payloads across the whole 2xx range', function () {
    // 202-only success: previously fell through to unknown.
    expectTypeOf<JsonOk<paths['/jobs']['get']>>().toEqualTypeOf<{
      queued: boolean;
    }>();
    // Several JSON 2xx statuses: 200 wins over 202.
    expectTypeOf<JsonOk<paths['/uploads']['post']>>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('rejects a path that is not a key of the spec', function () {
    // @ts-expect-error '/user' is not a key of paths
    typedUrl(create(), '/user');
    // @ts-expect-error '/users/{userId}' is not a key of paths either
    typedPath(create(), '/users/{userId}', { userId: 1 });
  });

  it('rejects placeholder params that miss or exceed the template', function () {
    // A params object missing a placeholder compiles only through a
    // deliberate type hole; at runtime the fill throws.
    const missing = () =>
      // @ts-expect-error missing key 'id'
      typedPath(create(), '/users/{id}', {});
    expect(missing).toThrow(TypeError);

    // Extra keys fail on object literals via excess property checking;
    // at runtime the extra entry is simply ignored.
    const extra = () =>
      // @ts-expect-error excess key 'page' — use querySet for query params
      typedPath(create(), '/users/{id}', { id: 1, page: 2 });
    expect(extra().url).toBe('/users/1');
  });

  it('rejects a method the path does not define, and the parameters key', function () {
    // @ts-expect-error 'delete' does not exist under '/users'
    typedMethod(typedUrl(create(), '/users'), 'delete');
    // @ts-expect-error 'parameters' is not an operation
    typedMethod(typedUrl(create(), '/users/{id}'), 'parameters');
  });

  it('rejects a body that does not satisfy the requestBody schema', function () {
    const o = typedMethod(typedUrl(create(), '/users'), 'post');
    // @ts-expect-error '{ nome }' misses 'name'
    typedJsonBody(o, 'post', { nome: 'Ada' });
  });

  it('rejects a reader that drifts from the set method', function () {
    const o = typedMethod(typedUrl(create(), '/users'), 'get');
    // @ts-expect-error method is 'GET' — the reader must read 'get'
    typedJson(o, 'post');
  });

  it('composes with the untyped pipe surface (query, retry, validate stay in play)', async function () {
    const mockFetch = vi.fn().mockResolvedValue(new Response('[]'));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const users = await client
      .pipe(typedUrl, '/users')
      .pipe(typedMethod, 'get')
      .pipe(typedJson, 'get')
      .pipe(doFetch);

    expect(users.ok).toBe(true);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://api.example.com/users');
    expectTypeOf(users).toEqualTypeOf<Response>();
  });
});
