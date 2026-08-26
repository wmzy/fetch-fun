import type { PlaceholderParams } from '@/index';

import { describe, it, expect, vi, expectTypeOf } from 'vitest';

import {
  path,
  fillPath,
  appendUrl,
  querySet,
  create,
  fetch as doFetch,
} from '@/index';

describe('fillPath', function () {
  it('fills placeholders from the template', function () {
    fillPath('/articles/{slug}', { slug: 'hello-world' }).should.be.eql(
      '/articles/hello-world'
    );
    fillPath('/users/{id}/posts/{postId}', {
      id: 7,
      postId: 'abc',
    }).should.be.eql('/users/7/posts/abc');
  });

  it('encodes special characters: spaces', function () {
    fillPath('/files/{name}', { name: 'my file.txt' }).should.be.eql(
      '/files/my%20file.txt'
    );
  });

  it('encodes slashes so a value cannot escape its segment', function () {
    fillPath('/users/{id}/posts', { id: 'a/b' }).should.be.eql(
      '/users/a%2Fb/posts'
    );
  });

  it('encodes reserved URI characters', function () {
    fillPath('/search/{q}', { q: 'a&b=c?d#e' }).should.be.eql(
      '/search/a%26b%3Dc%3Fd%23e'
    );
  });

  it('encodes non-ASCII characters', function () {
    fillPath('/tags/{tag}', { tag: '前端' }).should.be.eql(
      '/tags/%E5%89%8D%E7%AB%AF'
    );
  });

  it('passes a template without placeholders through unchanged', function () {
    fillPath('/users', {}).should.be.eql('/users');
  });

  it('fills repeated placeholders from one param', function () {
    fillPath('/compare/{a}/with/{a}', { a: 'x y' }).should.be.eql(
      '/compare/x%20y/with/x%20y'
    );
  });

  it('stringifies numbers', function () {
    fillPath('/users/{id}', { id: 42 }).should.be.eql('/users/42');
  });

  it('throws a TypeError naming the parameter and template when a param is missing', function () {
    const bad = { } as { slug: string | number };
    expect(() => fillPath('/articles/{slug}', bad)).toThrow(TypeError);
    expect(() => fillPath('/articles/{slug}', bad)).toThrow(
      'fillPath: missing path parameter "slug" for template "/articles/{slug}"'
    );
  });

  it('lists every missing parameter in the error', function () {
    const bad = { x: '1' } as { x: string; y: string; z: string };
    expect(() => fillPath('/a/{x}/b/{y}/c/{z}', bad)).toThrow(
      'fillPath: missing path parameters "y", "z" for template "/a/{x}/b/{y}/c/{z}"'
    );
  });

  it('throws a TypeError when a param value is undefined', function () {
    const bad = { slug: undefined } as unknown as { slug: string };
    expect(() => fillPath('/articles/{slug}', bad)).toThrow(TypeError);
    expect(() => fillPath('/articles/{slug}', bad)).toThrow(/"slug"/);
  });

  it('throws a TypeError when a placeholder survives the fill', function () {
    // Nested braces fill the inner {slug}, leaving an unresolved {…} shell.
    const bad = { slug: 'x' } as any;
    expect(() => fillPath('/link/{{slug}}', bad)).toThrow(TypeError);
    expect(() => fillPath('/link/{{slug}}', bad)).toThrow(
      '/link/{{slug}}'
    );
  });
});

describe('path', function () {
  it('stores the filled template as the url option', function () {
    path({}, '/articles/{slug}', { slug: 'hello' }).should.be.eql({
      url: '/articles/hello',
    });
  });

  it('replaces an existing url, like url() does', function () {
    path({ url: '/old' }, '/articles/{slug}', { slug: 'a/b' }).should.be.eql({
      url: '/articles/a%2Fb',
    });
  });

  it('composes in a pipe: the final request URL is the filled path', async function () {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    const res = await client
      .pipe(path, '/articles/{slug}', { slug: 'hello world' })
      .pipe(doFetch);

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://api.example.com/articles/hello%20world'
    );
  });

  it('composes with appendUrl and querySet in one chain', async function () {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const client = create({
      baseUrl: 'https://api.example.com',
      fetch: mockFetch as any,
    });

    await client
      .pipe(path, '/users/{id}', { id: 'a/b' })
      .pipe(appendUrl, '/posts')
      .pipe(querySet, 'page', 2)
      .pipe(doFetch);

    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://api.example.com/users/a%2Fb/posts?page=2'
    );
  });

  it('propagates the fill error when called through the pipe', function () {
    const client = create({ baseUrl: 'https://api.example.com' });
    expect(() =>
      client.pipe(path, '/articles/{slug}', {} as { slug: string })
    ).toThrow(TypeError);
  });
});

describe('path/fillPath types', function () {
  it('derives the exact params object from the template', function () {
    expectTypeOf<
      PlaceholderParams<'/articles/{slug}'>
    >().toEqualTypeOf<{ slug: string | number }>();
    expectTypeOf<
      PlaceholderParams<'/a/{x}/b/{y}'>
    >().toEqualTypeOf<{ x: string | number; y: string | number }>();
    expectTypeOf<
      keyof PlaceholderParams<'/users'>
    >().toEqualTypeOf<never>();
  });

  it('accepts correct params', function () {
    expectTypeOf(
      fillPath('/articles/{slug}', { slug: 'a' })
    ).toEqualTypeOf<string>();
    expectTypeOf(path({}, '/articles/{slug}', { slug: 1 }).url).toEqualTypeOf<
      string
    >();
  });

  it('rejects a missing placeholder key at compile time', function () {
    // A params object missing a placeholder compiles only through a
    // deliberate type hole; at runtime the fill throws.
    const missing = () =>
      // @ts-expect-error missing key 'y' — every placeholder is required
      fillPath('/a/{x}/b/{y}', { x: '1' });
    expect(missing).toThrow(TypeError);

    const viaPath = () =>
      // @ts-expect-error missing key 'slug'
      path({}, '/articles/{slug}', {});
    expect(viaPath).toThrow(TypeError);
  });

  it('rejects an extra key at compile time', function () {
    // Extra keys fail on object literals via excess property checking;
    // at runtime the extra entry is simply ignored.
    const filled = () =>
      // @ts-expect-error excess key 'z' — the template has no {z} placeholder
      fillPath('/a/{x}/b/{y}', { x: '1', y: 2, z: 3 });
    expect(filled()).toBe('/a/1/b/2');

    const viaPath = () =>
      // @ts-expect-error excess key 'page' — use querySet for query params
      path({}, '/articles/{slug}', { slug: 'a', page: 2 });
    expect(viaPath().url).toBe('/articles/a');
  });
});
