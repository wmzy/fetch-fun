import { describe, it, should } from 'vitest';
import {
  url,
  appendUrl,
  baseUrl,
  method,
  headers,
  header,
  accept,
  auth,
  contentType,
  middlewares,
  use,
  retry,
  mapResponse,
  checkError,
  data,
  json,
  text,
  blob,
  body,
  jsonBody,
  signal,
  timeout,
  query,
  mergeQuery,
  querySet,
  queryAppend,
} from '@/index';
import { dataSymbol } from '@/constants';
import { getData } from '@/util';

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

  it('method', function () {
    method({}, 'GET').should.be.eql({ method: 'GET' });
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

  it('header', function () {
    header({}, 'Content-Type', 'application/json').should.be.eql({
      headers: { 'Content-Type': 'application/json' },
    });
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
    const mw = [() => ({} as any)];
    middlewares({}, mw).should.be.eql({
      middlewares: mw,
    });
  });

  it('use', function () {
    const mw = () => ({} as any);
    use({}, mw).should.be.eql({
      middlewares: [mw],
    });
  });

  it('retry', function () {
    const mw = retry({}, 3);
    mw.middlewares.length.should.be.eql(1);
  });

  it('mapResponse', async function () {
    const mw = mapResponse({}, (res) => res);
    const res = await mw.middlewares[0](
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
      await mw.middlewares[0](
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
    const res = await mw.middlewares[0](
      () => Promise.resolve(new Response('ok')),
      mw as any
    )('');
    res.should.be.instanceof(Response);
  });

  it('data', async function () {
    const mw = data({}, (res) => res.json());
    const res = await mw.middlewares[0](
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

  it('json', async function () {
    const mw = json({});
    const res = await mw.middlewares[0](
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

  it('text', async function () {
    const mw = text({});
    const res = await mw.middlewares[0](
      () => Promise.resolve(new Response('text')),
      mw as any
    )('');
    getData<any>(res).should.be.eql('text');
  });

  it('blob', async function () {
    const mw = blob({});
    const res = await mw.middlewares[0](
      () => Promise.resolve(new Response(new Blob())),
      mw as any
    )('');
    res.should.have.property(dataSymbol);
  });

  it('body', function () {
    body({}, 'test body').should.be.eql({ body: 'test body' });
  });

  it('jsonBody', function () {
    jsonBody({}, { key: 'value' }).should.be.eql({
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    });
  });

  it('timeout', function () {
    const result = timeout({}, 5000);
    result.signal.should.be.instanceof(AbortSignal);
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
  });

  describe('queryAppend', function () {
    it('should append a single parameter', function () {
      const result = queryAppend({}, 'tag', 'javascript');
      result.searchParams.toString().should.be.eql('tag=javascript');
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
  });
});
