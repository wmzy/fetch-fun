import fetchMock from 'fetch-mock';
import {fetchFun, use, defaults} from '../src';

const example = 'https://example.com';

describe('fetch-fun', () => {
  beforeEach(() => {
    defaults.fetch = (...params) => global.fetch(...params);
  });

  afterEach(() => {
    fetchMock.restore();
  });

  it('should get an url ok', async () => {
    const mock = fetchMock.mock(example, 200);
    // eslint-disable-next-line builtin-compat/no-incompatible-builtins
    const res = await fetchFun.get(example);
    res.ok.should.be.true();
    mock.called(example).should.be.true();
  });

  it('should polyfill work', async () => {
    const fetch = fetchMock.sandbox().mock(example, 200);
    const mock = fetchMock.mock(example, 200);

    const res = await fetchFun({fetch, url: example});
    res.ok.should.be.true();

    fetch.called(example).should.be.true();
    mock.called(example).should.be.false();
  });

  it('should use middleware success', async () => {
    const mock = fetchMock
      .mock(example, 200)
      .mock('/test1', 200)
      .mock('/test2', 200);

    const res = await fetchFun(
      {url: example},
      use(next => (url, init) => next('/test1', init)),
      use(next => (url, init) => next('/test2', init))
    );

    res.ok.should.be.true();
    mock.called(example).should.be.false();
    mock.called('/test1').should.be.false();
    mock.called('/test2').should.be.true();
  });
});
