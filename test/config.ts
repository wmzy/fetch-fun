import { describe, it, should, expect, vi, expectTypeOf } from 'vitest';
import {
  url,
  appendUrl,
  baseUrl,
  method,
  get,
  post,
  put,
  patch,
  del,
  head,
  headers,
  header,
  accept,
  auth,
  contentType,
  middlewares,
  use,
  retry,
  mapResponse,
  mapError,
  checkError,
  data,
  json,
  text,
  blob,
  arrayBuffer,
  formData,
  body,
  jsonBody,
  signal,
  timeout,
  totalTimeout,
  query,
  mergeQuery,
  querySet,
  queryAppend,
  withRetry,
  withTimeout,
  validate,
  create,
  fetchData,
  fetchJSON,
  fetch as doFetch,
  toFetchParams,
 TimeoutError } from '@/index';
import type {
  MiddlewareFn,
  Options,
  StandardSchema,
  TypedURLSearchParams,
} from '@/index';
import { mapErrorSymbol, validateSymbol } from '@/constants';
import { getData, setData } from '@/util';

describe('config-build', function () {
  it('url', function () {
    url({}, 'https://x.y').should.be.eql({ url: 'https://x.y' });
  });

  it('appendUrl', function () {
    appendUrl({ url: 'https://x.y/api' }, '/x').should.be.eql({
      url: 'https://x.y/api/x',
    });
  });

  it('baseUrl', function () {
    baseUrl({}, 'https://x.y').should.be.eql({
      baseUrl: 'https://x.y',
    });
  });

  describe('url joining (toFetchParams)', function () {
    it('should use url as-is when no baseUrl is set', function () {
      toFetchParams({ url: '/users' })[0].should.be.eql('/users');
    });

    it('should join base path and path with a single slash', function () {
      toFetchParams({ baseUrl: '/v1', url: '/users' })[0].should.be.eql(
        '/v1/users'
      );
    });

    it('should add the missing slash when url has no leading slash', function () {
      toFetchParams({ baseUrl: 'https://x.com', url: 'users' })[0].should.be.eql(
        'https://x.com/users'
      );
    });

    it('should collapse duplicate slashes from base tail and url head', function () {
      toFetchParams({ baseUrl: 'https://x.com/v1/', url: '/users' })[0].should.be.eql(
        'https://x.com/v1/users'
      );
    });

    it('should ignore baseUrl when url is absolute', function () {
      toFetchParams({
        baseUrl: 'https://api.example.com',
        url: 'https://other.example.com/users',
      })[0].should.be.eql('https://other.example.com/users');
    });

    it('should append searchParams with & when url already has a query', function () {
      toFetchParams({
        baseUrl: 'https://x.com',
        url: '/users?existing=1',
        searchParams: new URLSearchParams('page=2'),
      })[0].should.be.eql('https://x.com/users?existing=1&page=2');
    });

    it('should append searchParams with ? when url has no query', function () {
      toFetchParams({
        baseUrl: 'https://x.com',
        url: '/users',
        searchParams: new URLSearchParams('page=2'),
      })[0].should.be.eql('https://x.com/users?page=2');
    });
  });

  it('method', function () {
    method({}, 'GET').should.be.eql({ method: 'GET' });
  });

  describe('method sugar', function () {
    it('sets the correct method for every helper', function () {
      get({}).should.be.eql({ method: 'GET' });
      post({}).should.be.eql({ method: 'POST' });
      put({}).should.be.eql({ method: 'PUT' });
      patch({}).should.be.eql({ method: 'PATCH' });
      del({}).should.be.eql({ method: 'DELETE' });
      head({}).should.be.eql({ method: 'HEAD' });
    });

    it('sets the url when a path is provided', function () {
      get({}, '/users').should.be.eql({ method: 'GET', url: '/users' });
      del({}, '/users/1').should.be.eql({
        method: 'DELETE',
        url: '/users/1',
      });
    });

    it('keeps the existing url when path is omitted', function () {
      get({ url: '/old' }).should.be.eql({ method: 'GET', url: '/old' });
      post({ url: '/old' }, undefined).should.be.eql({
        method: 'POST',
        url: '/old',
      });
    });

    it('serializes json into the body and sets Content-Type', function () {
      post({}, '/users', { name: 'Alice' }).should.be.eql({
        method: 'POST',
        url: '/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"Alice"}',
      });
      patch({ url: '/users/1' }, undefined, { name: 'Bob' }).should.be.eql({
        method: 'PATCH',
        url: '/users/1',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"Bob"}',
      });
    });

    it('leaves the body untouched when json is omitted', function () {
      const o = put({ url: '/u', body: 'raw' }, '/v');
      o.body.should.be.eql('raw');
      expect((o as Options).headers).toBeUndefined();
      o.url.should.be.eql('/v');
    });

    it('preserves other options through the sugar', function () {
      const s = new AbortController().signal;
      get({ signal: s, baseUrl: 'https://x.com' }, '/users').should.be.eql({
        method: 'GET',
        url: '/users',
        baseUrl: 'https://x.com',
        signal: s,
      });
    });

    it('tracks the method and url literal in the result type', () => {
      const withPath = post({}, '/users', { name: 'a' });
      expectTypeOf(withPath.method).toEqualTypeOf<'POST'>();
      expectTypeOf(withPath.url).toEqualTypeOf<'/users'>();
      // path omitted: the incoming url type survives the sugar
      const withoutPath = get(url({}, '/u'));
      expectTypeOf(withoutPath.method).toEqualTypeOf<'GET'>();
      expectTypeOf(withoutPath.url).toEqualTypeOf<'/u'>();
    });

    it('composes with the pipe protocol end to end', async function () {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const res = await doFetch(
        post(
          create({ baseUrl: 'https://x.com', fetch: mockFetch as any }),
          '/users',
          { name: 'Alice' }
        )
      );
      expect(res.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://x.com/users',
        expect.objectContaining({
          method: 'POST',
          body: '{"name":"Alice"}',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('pipes sugar helpers into fetchJSON at the type level', () => {
      // type-level only: the thunk is never invoked, no request is made
      const viaPost = () =>
        create()
          .pipe(post, '/users', { name: 'a' })
          .pipe(fetchJSON);
      expectTypeOf(viaPost).returns.resolves.toEqualTypeOf<unknown>();
      // path-omitted sugar keeps url, so the client stays fetchable
      const viaGet = () =>
        create()
          .pipe(url, '/u')
          .pipe(get)
          .pipe(fetchJSON);
      expectTypeOf(viaGet).returns.resolves.toEqualTypeOf<unknown>();
    });
  });

  it('signal', function () {
    const s = new AbortController().signal;
    signal({}, s).should.be.eql({
      signal: s,
    });
  });

  it('headers', function () {
    headers({}, { 'Content-Type': 'application/json' }).should.be.eql({
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('headers accepts a Headers instance and normalizes it to a record', function () {
    headers({}, new Headers({ 'X-Token': 'abc' })).should.be.eql({
      headers: { 'x-token': 'abc' },
    });
  });

  it('headers accepts a tuple array and normalizes it to a record', function () {
    headers({}, [
      ['X-A', '1'],
      ['X-B', '2'],
    ]).should.be.eql({ headers: { 'X-A': '1', 'X-B': '2' } });
  });

  it('header', function () {
    header({}, 'Content-Type', 'application/json').should.be.eql({
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('header preserves existing headers when o.headers is a Headers instance', function () {
    header(
      { headers: new Headers({ 'X-Old': 'kept' }) } as any,
      'X-New',
      'added'
    ).should.be.eql({ headers: { 'x-old': 'kept', 'X-New': 'added' } });
  });

  it('accept', function () {
    accept({}, 'application/json').should.be.eql({
      headers: { Accept: 'application/json' },
    });
  });

  it('auth', function () {
    auth({}, 'Bearer', 'token').should.be.eql({
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('contentType', function () {
    contentType({}, 'application/json').should.be.eql({
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('middlewares', function () {
    const mw: MiddlewareFn = (f) => f;
    const result = middlewares({}, [mw]);
    expect(result.middlewares).toHaveLength(1);
    expect(result.middlewares[0].middleware).toBe(mw);
  });

  it('use with function', function () {
    const mw: MiddlewareFn = (f) => f;
    const result = use({}, mw);
    expect(result.middlewares).toHaveLength(1);
    expect(result.middlewares[0].middleware).toBe(mw);
  });

  it('use with config', function () {
    const config = withRetry(3);
    const result = use({}, config);
    expect(result.middlewares).toHaveLength(1);
    expect(result.middlewares[0].name).toBe('builtin:retry');
  });

  it('middlewares type inference', function () {
    const mw: MiddlewareFn = (f) => f;
    const result = middlewares({}, [withRetry(3), withTimeout(5000), mw]);
    expect(result.middlewares).toHaveLength(3);

    type Actual = typeof result.middlewares;
    type AssertBrand<T, B> = T extends { __brand?: B } ? true : false;
    const _check0: AssertBrand<Actual[0], 'builtin:retry'> = true;
    const _check1: AssertBrand<Actual[1], 'builtin:timeout'> = true;
    const _check2: AssertBrand<Actual[2], 'unknown'> = true;
    expect(_check0 && _check1 && _check2).toBe(true);
  });

  it('use chaining type inference', function () {
    const mw: MiddlewareFn = (f) => f;
    const result = use(use(use({}, withRetry(3)), withTimeout(5000)), mw);

    type Actual = typeof result.middlewares;
    type AssertBrand<T, B> = T extends { __brand?: B } ? true : false;
    const _check0: AssertBrand<Actual[0], 'builtin:retry'> = true;
    const _check1: AssertBrand<Actual[1], 'builtin:timeout'> = true;
    const _check2: AssertBrand<Actual[2], 'unknown'> = true;
    expect(_check0 && _check1 && _check2).toBe(true);
  });

  it('retry', function () {
    const mw = retry({}, 3);
    mw.middlewares.length.should.be.eql(1);
  });

  it('mapResponse', async function () {
    const mw = mapResponse({}, (res) => res);
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response()),
      mw as any
    )('');
    res.should.be.instanceof(Response);
  });

  it('error', async function () {
    const mw = checkError({}, () => {
      throw new Error('test');
    });
    try {
      await mw.middlewares[0].middleware(
        () => Promise.resolve(new Response()),
        mw as any
      )('');
      should().fail();
    } catch (e) {
      (e as Error).message.should.be.eql('test');
    }
  });

  it('error should return response when no error thrown', async function () {
    const mw = checkError({}, () => {
      // no error thrown
    });
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response('ok')),
      mw as any
    )('');
    res.should.be.instanceof(Response);
  });

  it('data', async function () {
    const mw = data({}, (res) => res.json());
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(
          new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      mw as any
    )('');

    getData<any>(res).should.be.eql({});
  });

  it('data should preserve the Response instance', async function () {
    const mw = data({}, (res) => res.json());
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(
          new Response('{"ok":true}', {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      mw as any
    )('');

    res.should.be.instanceof(Response);
    res.status.should.be.eql(201);
    expect(res.headers.get('content-type')).to.equal('application/json');
    res.json.should.be.a('function');
    getData<any>(res).should.be.eql({ ok: true });
  });

  it('data should skip if already has data', async function () {
    const mw = data({}, (res) => res.json());
    const originalRes = new Response('{}');
    setData(originalRes, { existing: true });

    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(originalRes),
      mw as any
    )('');

    res.should.be.equal(originalRes);
    getData<any>(res).should.be.eql({ existing: true });
  });

  it('json', async function () {
    const mw = json({});
    // json() only configures response parsing; it must not set request headers
    expect((mw as { headers?: Record<string, string> }).headers).toBeUndefined();
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(
          new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      mw as any
    )('');
    getData<any>(res).should.be.eql({});
  });

  it('json should not touch existing request headers', function () {
    const o = json(header({}, 'X-Custom', 'yes'));
    o.headers.should.be.eql({ 'X-Custom': 'yes' });
  });

  it('text', async function () {
    const mw = text({});
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response('text')),
      mw as any
    )('');
    getData<any>(res).should.be.eql('text');
  });

  it('chained json and text should not consume the body twice', async function () {
    const o = text(
      json({
        url: 'https://x.y/api',
        fetch: (async () =>
          new Response('{"a":1}', {
            headers: { 'Content-Type': 'application/json' },
          })) as typeof fetch,
      })
    );
    const res = await doFetch(o);

    res.should.be.instanceof(Response);
    expect(res.headers.get('content-type')).to.equal('application/json');
    // the innermost data middleware (text) wins; json's reader is skipped
    getData<any>(res).should.be.eql('{"a":1}');
  });

  it('blob', async function () {
    const mw = blob({});
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response(new Blob())),
      mw as any
    )('');
    getData<any>(res).should.be.instanceof(Blob);
  });

  it('arrayBuffer', async function () {
    const mw = arrayBuffer({});
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
      mw as any
    )('');
    const buf = getData<ArrayBuffer>(res);
    buf.should.be.instanceof(ArrayBuffer);
    Array.from(new Uint8Array(buf)).should.be.eql([1, 2, 3]);
  });

  it('formData', async function () {
    const mw = formData({});
    const multipart =
      '--ff\r\n' +
      'Content-Disposition: form-data; name="field"\r\n' +
      '\r\n' +
      'value\r\n' +
      '--ff--\r\n';
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(
          new Response(multipart, {
            headers: { 'Content-Type': 'multipart/form-data; boundary=ff' },
          })
        ),
      mw as any
    )('');
    const fd = getData<FormData>(res);
    fd.should.be.instanceof(FormData);
    expect(fd.get('field')).to.equal('value');
  });

  it('json with a custom parser', async function () {
    const mw = json(
      {},
      (raw) =>
        JSON.parse(raw, (k, v) => (k === 'at' ? new Date(v) : v)) as {
          at: Date;
        }
    );
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(new Response('{"at":"2024-01-02T03:04:05.000Z"}')),
      mw as any
    )('');
    const parsed = getData<{ at: Date }>(res);
    parsed.at.should.be.instanceof(Date);
    parsed.at.toISOString().should.be.eql('2024-01-02T03:04:05.000Z');
  });

  it('json without a parser keeps the default behavior', async function () {
    const mw = json({});
    const res = await mw.middlewares[0].middleware(
      () =>
        Promise.resolve(
          new Response('{"n":1}', {
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      mw as any
    )('');
    getData<any>(res).should.be.eql({ n: 1 });
  });

  it('json resolves undefined for an empty body (204/205/HEAD)', async function () {
    // Regression: an empty body used to hit JSON.parse and throw
    // SyntaxError('Unexpected end of JSON input') before the empty-body
    // guard was added around the default parser.
    const mw = json({});
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response(null, { status: 204 })),
      mw as any
    )('');
    expect(getData(res)).to.equal(undefined);
  });

  it('json resolves undefined for a whitespace-only body', async function () {
    const mw = json({});
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response('   \n\t ')),
      mw as any
    )('');
    expect(getData(res)).to.equal(undefined);
  });

  it('json empty-body guard wraps a custom parser, which is not invoked', async function () {
    const parseJson = vi.fn((raw: string) => JSON.parse(raw));
    const mw = json({}, parseJson);
    const res = await mw.middlewares[0].middleware(
      () => Promise.resolve(new Response(null, { status: 204 })),
      mw as any
    )('');
    expect(getData(res)).to.equal(undefined);
    expect(parseJson).not.toHaveBeenCalled();
  });

  it('data reader type flows into fetchData without explicit generics', () => {
    // type-level only: the thunks are never invoked, no request is made
    const viaData = () =>
      create()
        .pipe(url, '/u')
        .pipe(data, (res) => res.json() as Promise<{ id: number }>)
        .pipe(fetchData);
    expectTypeOf(viaData).returns.resolves.toEqualTypeOf<{ id: number }>();
    // a sync reader works too: its return type is awaited
    const viaSync = () =>
      create()
        .pipe(url, '/u')
        .pipe(data, (res) => res.status)
        .pipe(fetchData);
    expectTypeOf(viaSync).returns.resolves.toEqualTypeOf<number>();
  });

  it('json/text/blob reader types flow into fetchData', () => {
    const viaJson = () => create().pipe(url, '/u').pipe(json).pipe(fetchData);
    expectTypeOf(viaJson).returns.resolves.toEqualTypeOf<unknown>();
    const viaText = () => create().pipe(url, '/u').pipe(text).pipe(fetchData);
    expectTypeOf(viaText).returns.resolves.toEqualTypeOf<string>();
    const viaBlob = () => create().pipe(url, '/u').pipe(blob).pipe(fetchData);
    expectTypeOf(viaBlob).returns.resolves.toEqualTypeOf<Blob>();
  });

  it('arrayBuffer/formData/json-parser reader types flow into fetchData', () => {
    const viaArrayBuffer = () =>
      create().pipe(url, '/u').pipe(arrayBuffer).pipe(fetchData);
    expectTypeOf(viaArrayBuffer).returns.resolves.toEqualTypeOf<ArrayBuffer>();
    const viaFormData = () =>
      create().pipe(url, '/u').pipe(formData).pipe(fetchData);
    expectTypeOf(viaFormData).returns.resolves.toEqualTypeOf<FormData>();
    const viaParser = () =>
      create()
        .pipe(url, '/u')
        .pipe(json, (raw: string) => JSON.parse(raw) as { at: Date })
        .pipe(fetchData);
    expectTypeOf(viaParser).returns.resolves.toEqualTypeOf<{ at: Date }>();
  });

  it('explicit fetchData/fetchJSON generics still narrow the result', () => {
    type User = { id: number };
    const viaInstantiation = () =>
      create()
        .pipe(url, '/u')
        .pipe(fetchData<User>);
    expectTypeOf(viaInstantiation).returns.resolves.toEqualTypeOf<User>();
    const viaFetchJSON = () => fetchJSON<User>(create().pipe(url, '/u'));
    expectTypeOf(viaFetchJSON).returns.resolves.toEqualTypeOf<User>();
  });

  it('fetchData without a reader resolves to unknown', () => {
    const noReader = () => create().pipe(url, '/u').pipe(fetchData);
    expectTypeOf(noReader).returns.resolves.toEqualTypeOf<unknown>();
  });

  it('body', function () {
    body({}, 'test body').should.be.eql({ body: 'test body' });
  });

  it('body passes non-string bodies through as-is', function () {
    const fd = new FormData();
    fd.append('file', 'content');
    expect(body({}, fd).body).toBe(fd);
    expect(body({}, new Blob(['binary'])).body).toBeInstanceOf(Blob);
    expect(body({}, new URLSearchParams({ a: '1' })).body).toBeInstanceOf(
      URLSearchParams
    );
    expect(body({}, null).body).toBe(null);
  });

  it('jsonBody', function () {
    jsonBody({}, { key: 'value' }).should.be.eql({
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    });
  });

  it('timeout', function () {
    timeout({}, 5000).should.be.eql({ timeoutMs: 5000 });
  });

  it('timeout is lazy: the timer starts when the request runs, not at pipe time', async function () {
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) => {
        // Real fetch semantics: an already-aborted signal fails the request.
        if (init?.signal?.aborted) {
          return Promise.reject(
            new DOMException('This operation was aborted', 'AbortError')
          );
        }
        return Promise.resolve(new Response('ok'));
      }
    );

    const client = timeout(
      { url: 'https://x.y/api', fetch: mockFetch as any },
      50
    );

    // Well past the 50ms budget: with an eager pipe-time timer this request
    // would abort immediately; lazily it gets a full fresh budget.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const response = await doFetch(client);
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it('timeout: a later pipe overwrites the previous value', function () {
    timeout(timeout({}, 1000), 2000).should.be.eql({ timeoutMs: 2000 });
  });

  describe('totalTimeout', function () {
    it('stores the whole-request budget', function () {
      totalTimeout({}, 5000).should.be.eql({ totalTimeoutMs: 5000 });
    });

    it('a later pipe overwrites the previous value', function () {
      totalTimeout(totalTimeout({}, 1000), 2000).should.be.eql({
        totalTimeoutMs: 2000,
      });
    });

    it('rejects with TimeoutError carrying the budget when the request hangs', async function () {
      // AbortSignal.timeout runs on the native event loop — real timers and
      // short real budgets (30ms) are required; fake timers never fire it.
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = totalTimeout(
        { url: 'https://x.y/api', fetch: mockFetch as any },
        30
      );

      let caught: unknown;
      try {
        await doFetch(client);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).message).toBe(
        'Request timed out after 30ms'
      );
      expect((caught as TimeoutError).cause).toBeInstanceOf(DOMException);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('bounds a retry loop: the budget preempts further attempts', async function () {
      // Core scenario: retry(2) with a hanging (>= 30ms) attempt would drag
      // on through every attempt + backoff; the 40ms whole-request budget
      // cuts it short with a TimeoutError.
      let startedAttempts = 0;
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        // Real fetch semantics: an already-aborted signal fails immediately.
        if (init?.signal?.aborted) {
          return Promise.reject(init.signal.reason);
        }
        startedAttempts += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = create({ fetch: mockFetch as any })
        .pipe(retry, 2, { delay: { initial: 5, max: 5, multiplier: 1 } })
        .pipe(totalTimeout, 40)
        .pipe(url, 'https://x.y/api');

      let caught: unknown;
      try {
        await doFetch(client);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).message).toBe(
        'Request timed out after 40ms'
      );
      // Only the first attempt actually started work; once the budget
      // elapsed the remaining retries failed instantly on the aborted
      // signal instead of re-running the slow attempt.
      expect(startedAttempts).toBeLessThan(3);
      expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('propagates a user abort unchanged (AbortError, not TimeoutError)', async function () {
      const controller = new AbortController();
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = totalTimeout(
        { url: 'https://x.y/api', fetch: mockFetch as any, signal: controller.signal },
        1000
      );

      setTimeout(() => controller.abort(), 20);

      let caught: unknown;
      try {
        await doFetch(client);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(DOMException);
      expect((caught as DOMException).name).toBe('AbortError');
      expect(caught).not.toBeInstanceOf(TimeoutError);
    });

    it('does not affect a fast response within the budget', async function () {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('ok'));

      const client = totalTimeout(
        { url: 'https://x.y/api', fetch: mockFetch as any },
        100
      );

      const response = await doFetch(client);
      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    });

    it('composes with the per-attempt timeout: nested AbortSignal.any layers', async function () {
      // A generous per-attempt budget inside a tight whole-request budget:
      // the outer layer must fire and win, proving the two AbortSignal.any
      // compositions nest cleanly.
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        });
      });

      const client = totalTimeout(
        timeout({ url: 'https://x.y/api', fetch: mockFetch as any }, 5000),
        30
      );

      let caught: unknown;
      try {
        await doFetch(client);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).message).toBe(
        'Request timed out after 30ms'
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('query', function () {
    it('should set searchParams from string', function () {
      const result = query({}, 'page=1&limit=10');
      result.searchParams.toString().should.be.eql('page=1&limit=10');
    });

    it('should replace existing searchParams', function () {
      const existing = new URLSearchParams('old=value');
      const result = query({ searchParams: existing }, 'page=1');
      result.searchParams.toString().should.be.eql('page=1');
    });

    it('should handle URLSearchParams input', function () {
      const result = query({}, new URLSearchParams({ page: '1', limit: '10' }));
      result.searchParams.get('page')!.should.be.eql('1');
      result.searchParams.get('limit')!.should.be.eql('10');
    });

    it('should handle empty query string', function () {
      const result = query({}, '');
      result.searchParams.toString().should.be.eql('');
    });

    it('should handle empty URLSearchParams', function () {
      const result = query({}, new URLSearchParams());
      result.searchParams.size.should.be.eql(0);
    });

    it('should stringify number and boolean record values', function () {
      const result = query({}, { page: 1, active: true, archived: false });
      result.searchParams.get('page')!.should.be.eql('1');
      result.searchParams.get('active')!.should.be.eql('true');
      result.searchParams.get('archived')!.should.be.eql('false');
    });

    it('should accept mixed-type tuple input', function () {
      const result = query({}, [
        ['page', 1],
        ['active', true],
        ['tag', 'a'],
      ]);
      result.searchParams.toString().should.be.eql('page=1&active=true&tag=a');
    });
  });

  describe('mergeQuery', function () {
    it('should merge with existing searchParams', function () {
      const existing = new URLSearchParams('page=1');
      const result = mergeQuery({ searchParams: existing }, 'limit=10');
      result.searchParams.toString().should.be.eql('page=1&limit=10');
    });

    it('should create searchParams if not exists', function () {
      const result = mergeQuery({}, 'page=1');
      result.searchParams.toString().should.be.eql('page=1');
    });

    it('should handle URLSearchParams input', function () {
      const existing = new URLSearchParams('page=1');
      const result = mergeQuery(
        { searchParams: existing },
        new URLSearchParams({ limit: '10' })
      );
      result.searchParams.toString().should.be.eql('page=1&limit=10');
    });

    it('should allow duplicate keys', function () {
      const existing = new URLSearchParams('tag=a');
      const result = mergeQuery({ searchParams: existing }, 'tag=b');
      result.searchParams.toString().should.be.eql('tag=a&tag=b');
    });

    it('should handle empty merge', function () {
      const existing = new URLSearchParams('page=1');
      const result = mergeQuery({ searchParams: existing }, '');
      result.searchParams.toString().should.be.eql('page=1');
    });

    it('should handle object input', function () {
      const result = mergeQuery({}, { page: '1', limit: '10' });
      result.searchParams.get('page')!.should.be.eql('1');
      result.searchParams.get('limit')!.should.be.eql('10');
    });

    it('should stringify non-string values when merging an object', function () {
      const existing = new URLSearchParams('page=1');
      const result = mergeQuery({ searchParams: existing }, {
        limit: 10,
        active: true,
      });
      result.searchParams
        .toString()
        .should.be.eql('page=1&limit=10&active=true');
    });

    it('should merge mixed-type tuple input', function () {
      const result = mergeQuery({}, [
        ['page', 1],
        ['tag', 'a'],
      ]);
      result.searchParams.toString().should.be.eql('page=1&tag=a');
    });
  });

  describe('querySet', function () {
    it('should set a single parameter', function () {
      const result = querySet({}, 'page', '1');
      result.searchParams.toString().should.be.eql('page=1');
    });

    it('should replace existing value for same key', function () {
      const existing = new URLSearchParams('page=1');
      const result = querySet({ searchParams: existing }, 'page', '2');
      result.searchParams.toString().should.be.eql('page=2');
    });

    it('should preserve other parameters', function () {
      const existing = new URLSearchParams('page=1&limit=10');
      const result = querySet({ searchParams: existing }, 'page', '2');
      result.searchParams.get('page')!.should.be.eql('2');
      result.searchParams.get('limit')!.should.be.eql('10');
    });

    it('should add new parameter to existing searchParams', function () {
      const existing = new URLSearchParams('page=1');
      const result = querySet({ searchParams: existing }, 'limit', '10');
      result.searchParams.toString().should.be.eql('page=1&limit=10');
    });

    it('should stringify number and boolean values', function () {
      const result = querySet({}, 'page', 1);
      result.searchParams.toString().should.be.eql('page=1');
      const withFlag = querySet(result, 'active', true);
      withFlag.searchParams.toString().should.be.eql('page=1&active=true');
    });

    it('tracks stringified literals in the phantom type', () => {
      const result = querySet({}, 'page', 1);
      expectTypeOf(result.searchParams).toEqualTypeOf<
        TypedURLSearchParams<{ page: '1' }>
      >();
      const chained = querySet(result, 'active', true);
      expectTypeOf(chained.searchParams).toEqualTypeOf<
        TypedURLSearchParams<{ page: '1'; active: 'true' }>
      >();
    });
  });

  describe('queryAppend', function () {
    it('should append a single parameter', function () {
      const result = queryAppend({}, 'tag', 'b');
      result.searchParams.toString().should.be.eql('tag=b');
    });

    it('should allow duplicate keys', function () {
      const existing = new URLSearchParams('tag=a');
      const result = queryAppend({ searchParams: existing }, 'tag', 'b');
      result.searchParams.toString().should.be.eql('tag=a&tag=b');
    });

    it('should create searchParams if not exists', function () {
      const result = queryAppend({}, 'page', '1');
      result.searchParams.toString().should.be.eql('page=1');
    });

    it('should preserve existing parameters', function () {
      const existing = new URLSearchParams('page=1');
      const result = queryAppend({ searchParams: existing }, 'limit', '10');
      result.searchParams.toString().should.be.eql('page=1&limit=10');
    });

    it('should stringify number and boolean values', function () {
      const result = queryAppend({}, 'limit', 10);
      result.searchParams.toString().should.be.eql('limit=10');
      const withFlag = queryAppend(result, 'active', false);
      withFlag.searchParams.toString().should.be.eql('limit=10&active=false');
    });

    it('tracks stringified literals in the phantom type', () => {
      const first = queryAppend({}, 'tag', 'a');
      const second = queryAppend(first, 'tag', 2);
      expectTypeOf(second.searchParams).toEqualTypeOf<
        TypedURLSearchParams<{ tag: ['a', '2'] }>
      >();
    });
  });

  describe('validate', function () {
    const schema: StandardSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      },
    };

    it('should attach the schema to the options', function () {
      const result = validate({ url: 'https://x.y' }, schema);
      result.url.should.be.eql('https://x.y');
      (result as any)[validateSymbol].should.be.equal(schema);
    });

    it('should throw TypeError for non Standard Schema input', function () {
      expect(() => validate({}, {} as any)).toThrow(TypeError);
      expect(() => validate({}, null as any)).toThrow(TypeError);
      expect(() =>
        validate(
          {},
          { '~standard': { version: 2, validate: () => ({}) } } as any
        )
      ).toThrow(/Standard Schema v1/);
      expect(() =>
        validate({}, { '~standard': { version: 1 } } as any)
      ).toThrow(TypeError);
    });

    it('should converge fetchData to the schema output type', () => {
      type User = { id: number; name: string };
      const userSchema: StandardSchema<User> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({ value: value as User }),
        },
      };
      const viaSchema = () =>
        create()
          .pipe(url, '/u')
          .pipe(json)
          .pipe(validate, userSchema)
          .pipe(fetchData);
      expectTypeOf(viaSchema).returns.resolves.toEqualTypeOf<User>();
      // explicit generic still overrides after validate
      const viaOverride = () =>
        create()
          .pipe(url, '/u')
          .pipe(json)
          .pipe(validate, userSchema)
          .pipe(fetchData<{ override: true }>);
      expectTypeOf(viaOverride).returns.resolves.toEqualTypeOf<{
        override: true;
      }>();
    });
  });

  describe('mapError', function () {
    it('should store the mapper under the symbol key', function () {
      const mapper = (e: unknown) => e;
      const result = mapError({ url: 'https://x.y' }, mapper);
      result.url.should.be.eql('https://x.y');
      (result as any)[mapErrorSymbol].should.be.equal(mapper);
    });

    it('should overwrite a previous mapper (last pipe wins)', function () {
      const first = () => new Error('first');
      const second = () => new Error('second');
      const result = mapError(mapError({ url: 'https://x.y' }, first), second);
      (result as any)[mapErrorSymbol].should.be.equal(second);
    });

    it('should not mutate the input options', function () {
      const original = { url: 'https://x.y' };
      mapError(original, (e) => e);
      expect(Object.getOwnPropertySymbols(original)).toHaveLength(0);
    });
  });
});
