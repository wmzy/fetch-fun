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
 * exclude, a 201-only success (POST /users), and a JSON-less 204.
 */
type paths = {
  '/users': {
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
}

const { typedUrl, typedPath, typedMethod, typedJsonBody, typedJson } =
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
