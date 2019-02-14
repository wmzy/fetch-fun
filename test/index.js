import fetchMock from 'fetch-mock';
import { fetch, use } from '../src';

const example = 'https://example.com';

describe('fetch-fun', () => {
  afterEach(() => {
    fetchMock.restore();
  });

  it('should fetch an url ok', async () => {
    const mock = fetchMock.mock(example, 200);
    const res = await fetch(example);
    res.ok.should.be.true();
    mock.called(example).should.be.true();
  });

  it('should polyfill work', async () => {
    const polyfill = fetchMock.sandbox().mock(example, 200);
    const mock = fetchMock.mock(example, 200);

    const res = await fetch({polyfill, url: example});
    res.ok.should.be.true();

    polyfill.called(example).should.be.true();
    mock.called(example).should.be.false();
  });

  it('should use middleware success', async () => {
    const mock = fetchMock
      .mock(example, 200)
      .mock('/test1', 200)
      .mock('/test2', 200);
    const res = ({url: example})
      |> use(ctx => {ctx.url = '/test1';})(#)
      |> use(ctx => {ctx.url = '/test2';})(#)
      |> await fetch(#);

    res.ok.should.be.true();
    mock.called(example).should.be.false();
    mock.called('/test1').should.be.false();
    mock.called('/test2').should.be.true();
  });
});
