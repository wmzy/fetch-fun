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
});
